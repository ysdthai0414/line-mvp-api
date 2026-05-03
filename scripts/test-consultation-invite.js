#!/usr/bin/env node
// =============================================================
// 相談会の参加打診 push + postback (Phase 3b-2) 結合テスト
//
// 使い方:
//   node scripts/test-consultation-invite.js
//
// 何をするか:
//   1) クリーンアップ
//   2) ホスト会社1社・テストユーザー2名・MatchingRequest 2件を作成
//   3) ConsultationEvent を作成（zoom_url 付き）
//   4) inviteParticipantsFromMatchingRequests で 2 名を 'invited' に
//   5) getInvitedNotPushed が 2件返ること
//   6) buildConsultationInviteFlex の構造チェック（altText / contents.type / footer の postback data）
//   7) markPushed で 1 名を pushed_at セット → getInvitedNotPushed が 1件に減る
//   8) postback シミュレーション: setParticipantStatus(eventId, user, 'joined') → getEvent で counts 確認
//   9) postback シミュレーション: setParticipantStatus(eventId, user, 'declined')
//   10) clearPushedAt で全クリア → getInvitedNotPushed が再び対象として復活する条件を検証
//   11) クリーンアップ
//
// LINE API は呼ばない（Flex 構造の検証 + DB操作のみ）
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { getPool } = require("../src/db");
const { recordMatchingRequest } = require("../src/matching");
const {
  createEvent,
  getEvent,
  inviteParticipantsFromMatchingRequests,
  setParticipantStatus,
  getInvitedNotPushed,
  markPushed,
  clearPushedAt,
} = require("../src/consultation");
const { buildConsultationInviteFlex } = require("../src/flex");

const TEST_USER_PREFIX = "U_TEST_INVITE_";
const TEST_EVENT_TITLE_TAG = "[TEST_INVITE_FLOW]";

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function cleanup() {
  const pool = getPool();
  await pool.execute(
    "DELETE cp FROM ConsultationParticipants cp " +
    "JOIN ConsultationEvents ce ON ce.id = cp.consultation_event_id " +
    "WHERE ce.title LIKE ?",
    ["%" + TEST_EVENT_TITLE_TAG + "%"]
  );
  await pool.execute(
    "DELETE FROM ConsultationEvents WHERE title LIKE ?",
    ["%" + TEST_EVENT_TITLE_TAG + "%"]
  );
  await pool.execute(
    "DELETE FROM MatchingRequests WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  await pool.execute(
    "DELETE FROM DeliveryLog WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  await pool.execute(
    "DELETE FROM Profiles WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  await pool.execute(
    "DELETE FROM Users WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
}

async function pickHostCompany() {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id, company_name, prefecture FROM ApprovedCompanies " +
    "WHERE prefecture IS NOT NULL ORDER BY id LIMIT 1"
  );
  return rows[0] || null;
}

async function setupUsers(myCompanyId) {
  const pool = getPool();
  const users = [TEST_USER_PREFIX + "1", TEST_USER_PREFIX + "2"];
  for (const u of users) {
    await pool.execute(
      "INSERT INTO Users " +
      "(line_user_id, state, approved_company_id, sales_tier, annual_sales) " +
      "VALUES (?, 'CONFIRMED', ?, '10_30', 1500000000)",
      [u, myCompanyId]
    );
  }
  return users;
}

async function main() {
  console.log("=== Phase 3b-2 参加打診 push + postback テスト ===");

  let host;
  let users = [];
  let eventId = null;

  try {
    console.log("\n[STEP 0] cleanup");
    await cleanup();
    pass("pre-cleanup done");

    console.log("\n[STEP 1] ホスト会社確保");
    host = await pickHostCompany();
    if (!host) throw new Error("認可企業データが取れません");
    console.log("  host: id=" + host.id + " name=" + host.company_name);
    pass("host company picked");

    console.log("\n[STEP 2] テストユーザー2名作成 + MatchingRequest 2件");
    // ユーザーは host とは別の company_id を使う
    const pool = getPool();
    const [otherRows] = await pool.execute(
      "SELECT id FROM ApprovedCompanies WHERE id <> ? ORDER BY id LIMIT 1",
      [host.id]
    );
    const myCompanyId = otherRows[0] ? otherRows[0].id : host.id;
    users = await setupUsers(myCompanyId);
    for (const u of users) {
      await recordMatchingRequest({
        lineUserId: u,
        targetCompanyId: host.id,
        sourceInitiativeId: null,
      });
    }
    pass("users + requests created");

    console.log("\n[STEP 3] ConsultationEvent (zoom_url付き) を作成");
    const futureDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    eventId = await createEvent({
      hostCompanyId: host.id,
      title: TEST_EVENT_TITLE_TAG + " " + host.company_name + " 招待テスト",
      description: "招待テスト用",
      scheduledAt: futureDate,
      durationMinutes: 60,
      zoomUrl: "https://zoom.us/j/" + Date.now(),
      capacity: 5,
      status: "recruiting",
    });
    check(typeof eventId === "number" && eventId > 0, "event created (id=" + eventId + ")");

    console.log("\n[STEP 4] inviteParticipantsFromMatchingRequests");
    const inv = await inviteParticipantsFromMatchingRequests(eventId, host.id);
    check(inv.invited === 2, "invited 2", "actual=" + inv.invited);

    console.log("\n[STEP 5] getInvitedNotPushed が 2件");
    const before = await getInvitedNotPushed(eventId);
    check(before.length === 2, "2 invited not pushed", "actual=" + before.length);

    console.log("\n[STEP 6] buildConsultationInviteFlex の構造チェック");
    const ev = await getEvent(eventId);
    const flex = buildConsultationInviteFlex(ev);
    check(flex && flex.type === "flex", "flex.type === 'flex'");
    check(
      typeof flex.altText === "string" && flex.altText.indexOf("相談会") >= 0,
      "altText contains '相談会'"
    );
    check(flex.contents && flex.contents.type === "bubble", "contents.type === 'bubble'");
    const footerContents = flex.contents.footer && flex.contents.footer.contents;
    const buttonRow = footerContents && footerContents[0];
    const buttons = buttonRow && buttonRow.contents;
    check(
      Array.isArray(buttons) && buttons.length === 2,
      "footer has 2 buttons (decline + join)"
    );
    if (buttons) {
      const dataAttrs = buttons.map((b) => b.action && b.action.data);
      check(
        dataAttrs.some((d) => d && d.indexOf("value=join") >= 0),
        "one button has value=join"
      );
      check(
        dataAttrs.some((d) => d && d.indexOf("value=decline") >= 0),
        "one button has value=decline"
      );
      check(
        dataAttrs.every((d) => d && d.indexOf("event_id=" + eventId) >= 0),
        "all buttons reference correct event_id"
      );
    }

    console.log("\n[STEP 7] markPushed で 1名を済にする → 残り 1件");
    const ok = await markPushed(eventId, users[0]);
    check(ok, "markPushed returned true for first user");
    const okAgain = await markPushed(eventId, users[0]);
    check(!okAgain, "markPushed returns false on idempotent re-call");
    const after = await getInvitedNotPushed(eventId);
    check(after.length === 1, "1 invited not pushed after markPushed");

    console.log("\n[STEP 8] postback シミュレーション: 'join' で users[1] → joined");
    const okJoin = await setParticipantStatus(eventId, users[1], "joined");
    check(okJoin, "setParticipantStatus join ok");
    const evJ = await getEvent(eventId);
    check(evJ.participant_counts.joined === 1, "counts.joined === 1");

    console.log("\n[STEP 9] postback シミュレーション: 'decline' で users[0] → declined");
    const okDec = await setParticipantStatus(eventId, users[0], "declined");
    check(okDec, "setParticipantStatus decline ok");
    const evD = await getEvent(eventId);
    check(evD.participant_counts.declined === 1, "counts.declined === 1");

    console.log("\n[STEP 10] clearPushedAt で全クリア");
    await clearPushedAt(eventId);
    // 既に joined/declined になっているので、status='invited' のものは0件のはず
    const afterClear = await getInvitedNotPushed(eventId);
    check(
      afterClear.length === 0,
      "0 invited-not-pushed (all are joined/declined now)",
      "actual=" + afterClear.length
    );

    console.log("\n=== 結果: " + passed + " passed, " + failed + " failed ===");
  } catch (err) {
    console.error("[test] fatal:", err);
    failed++;
  } finally {
    console.log("\n[cleanup]");
    try {
      await cleanup();
      console.log("  ✓ cleanup done");
    } catch (e) {
      console.warn("  ✗ cleanup failed:", e.message);
    }
    await getPool().end();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
