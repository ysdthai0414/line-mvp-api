#!/usr/bin/env node
// =============================================================
// 相談会フロー (Phase 3b-1) 結合テスト
//
// 使い方:
//   node scripts/test-consultation-flow.js
//
// 動作:
//   1) クリーンアップ（既存テスト残骸を一掃）
//   2) テスト用ホスト会社1社・参加候補ユーザー2名を確保
//   3) 2名がそれぞれ pending な MatchingRequest を発行
//   4) ConsultationEvent を planned で作成
//   5) inviteParticipantsFromMatchingRequests で2名を 'invited' に
//      → MatchingRequests は 'queued_for_event' に変わる
//   6) 1名を 'joined'、1名を 'declined' にステータス更新
//   7) Event を recruiting → confirmed → held に遷移
//   8) getEvent で参加者件数集計を確認
//   9) 不正ステータスを setParticipantStatus に渡したら例外
//   10) クリーンアップ（finally で必ず実行）
//
// 注意: LINE API は呼ばない。実DBに対するCRUDのみ。
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { getPool } = require("../src/db");
const { recordMatchingRequest } = require("../src/matching");
const {
  createEvent,
  getEvent,
  listEvents,
  updateEventStatus,
  getParticipants,
  setParticipantStatus,
  inviteParticipantsFromMatchingRequests,
} = require("../src/consultation");

const TEST_USER_PREFIX = "U_TEST_CONSULT_";
const TEST_EVENT_TITLE_TAG = "[TEST_CONSULT_FLOW]";

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function cleanup() {
  const pool = getPool();
  // テスト相談会の参加者を削除（CASCADE があるが安全のため明示）
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
  // テストユーザー関連
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
  // 自分以外の認可企業を1社（株式会社大和=154 とは別の方が安心）
  const [rows] = await pool.execute(
    "SELECT id, company_name, prefecture FROM ApprovedCompanies " +
    "WHERE prefecture IS NOT NULL AND id <> 154 " +
    "ORDER BY id LIMIT 1"
  );
  return rows[0] || null;
}

async function setupUsers(hostCompanyId) {
  const pool = getPool();
  const users = [TEST_USER_PREFIX + "1", TEST_USER_PREFIX + "2"];
  // 自社（hostCompanyId）以外を割り当てる必要があるので host とは別の company_id を確保
  const [otherRows] = await pool.execute(
    "SELECT id FROM ApprovedCompanies WHERE id <> ? ORDER BY id LIMIT 1",
    [hostCompanyId]
  );
  const myCompanyId = otherRows[0] ? otherRows[0].id : hostCompanyId;
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
  console.log("=== Phase 3b-1 相談会フロー 結合テスト ===");

  let host;
  let users = [];
  let eventId;

  try {
    console.log("\n[STEP 0] 既存テストデータをクリーンアップ");
    await cleanup();
    pass("pre-cleanup done");

    console.log("\n[STEP 1] テスト用ホスト会社を確保");
    host = await pickHostCompany();
    if (!host) throw new Error("認可企業データが取れません");
    console.log("  host: id=" + host.id + " name=" + host.company_name);
    pass("host company picked");

    console.log("\n[STEP 2] テストユーザー 2名を作成");
    users = await setupUsers(host.id);
    pass("test users created (count=" + users.length + ")");

    console.log("\n[STEP 3] 各ユーザーが host へ MatchingRequest 発行");
    for (const u of users) {
      await recordMatchingRequest({
        lineUserId: u,
        targetCompanyId: host.id,
        sourceInitiativeId: null,
      });
    }
    const pool = getPool();
    const [pendCheck] = await pool.execute(
      "SELECT COUNT(*) AS n FROM MatchingRequests " +
      "WHERE target_approved_company_id = ? AND status = 'pending' " +
      "  AND line_user_id LIKE ?",
      [host.id, TEST_USER_PREFIX + "%"]
    );
    check(pendCheck[0].n === 2, "matching requests created (count=2)");

    console.log("\n[STEP 4] ConsultationEvent を planned で作成");
    const futureDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 2週間後
    eventId = await createEvent({
      hostCompanyId: host.id,
      title: TEST_EVENT_TITLE_TAG + " " + host.company_name + " テスト相談会",
      description: "テスト用の相談会",
      scheduledAt: futureDate,
      durationMinutes: 60,
      zoomUrl: "https://zoom.us/test/" + Date.now(),
      capacity: 5,
      status: "planned",
    });
    check(typeof eventId === "number" && eventId > 0, "event created (id=" + eventId + ")");

    const ev0 = await getEvent(eventId);
    check(!!ev0, "event fetched");
    check(ev0.status === "planned", "initial status = planned");
    check(ev0.host_approved_company_id === host.id, "host company id matches");

    console.log("\n[STEP 5] inviteParticipantsFromMatchingRequests で 2名を invited に");
    const inv = await inviteParticipantsFromMatchingRequests(eventId, host.id);
    check(inv.invited === 2, "invited 2 users", "actual=" + inv.invited);
    check(inv.totalPending === 2, "totalPending=2", "actual=" + inv.totalPending);

    const parts = await getParticipants(eventId);
    check(parts.length === 2, "2 participants in event");
    check(
      parts.every((p) => p.status === "invited"),
      "all participants are 'invited'"
    );

    // pending → queued_for_event
    const [statCheck] = await pool.execute(
      "SELECT status, COUNT(*) AS n FROM MatchingRequests " +
      "WHERE target_approved_company_id = ? AND line_user_id LIKE ? " +
      "GROUP BY status",
      [host.id, TEST_USER_PREFIX + "%"]
    );
    const queuedRow = statCheck.find((r) => r.status === "queued_for_event");
    check(
      queuedRow && queuedRow.n === 2,
      "MatchingRequests moved to 'queued_for_event'"
    );

    console.log("\n[STEP 6] 参加者ステータスを joined / declined に更新");
    const ok1 = await setParticipantStatus(eventId, users[0], "joined");
    const ok2 = await setParticipantStatus(eventId, users[1], "declined");
    check(ok1, "user[0] → joined");
    check(ok2, "user[1] → declined");

    const ev1 = await getEvent(eventId);
    check(
      ev1.participant_counts.joined === 1,
      "participant_counts.joined === 1"
    );
    check(
      ev1.participant_counts.declined === 1,
      "participant_counts.declined === 1"
    );

    console.log("\n[STEP 7] Event ステータス遷移 recruiting → confirmed → held");
    await updateEventStatus(eventId, "recruiting");
    const evR = await getEvent(eventId);
    check(evR.status === "recruiting", "status=recruiting");

    await updateEventStatus(eventId, "confirmed");
    const evC = await getEvent(eventId);
    check(evC.status === "confirmed", "status=confirmed");

    await updateEventStatus(eventId, "held");
    const evH = await getEvent(eventId);
    check(evH.status === "held", "status=held");

    // 出席記録の例（「joined」→ 'attended' へ）
    await setParticipantStatus(eventId, users[0], "attended", "テスト出席");
    const ev2 = await getEvent(eventId);
    check(
      ev2.participant_counts.attended === 1,
      "participant_counts.attended === 1"
    );

    console.log("\n[STEP 8] listEvents が今回作成した event を含む");
    const listed = await listEvents({ status: "held", limit: 50 });
    const listedHit = listed.find((e) => e.id === eventId);
    check(!!listedHit, "listEvents(status=held) contains the test event");

    console.log("\n[STEP 9] 不正ステータスは例外を投げる");
    let threw = false;
    try {
      await setParticipantStatus(eventId, users[0], "INVALID_STATUS");
    } catch (e) {
      threw = true;
    }
    check(threw, "setParticipantStatus throws on invalid status");

    let threw2 = false;
    try {
      await updateEventStatus(eventId, "WHATEVER");
    } catch (e) {
      threw2 = true;
    }
    check(threw2, "updateEventStatus throws on invalid status");

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
