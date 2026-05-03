#!/usr/bin/env node
// =============================================================
// リマインド + アーカイブ配信 (Phase 3b-3) 結合テスト
//
// 使い方:
//   node scripts/test-consultation-reminders.js
//
// シナリオ:
//   1) クリーンアップ
//   2) ホスト会社・テストユーザー2名・MatchingRequest 2件 作成
//   3) ConsultationEvent を「12時間後」に作成 (status=confirmed, zoom_url付き)
//   4) inviteParticipantsFromMatchingRequests で2名 invited
//   5) 2名とも joined にステータス変更
//   6) findUpcomingEventsNeedingReminder(24) で当該eventが対象として返る
//   7) buildConsultationReminderFlex の構造（type=flex, header背景色#E89F2A, footer Zoom URI ボタン）
//   8) getJoinedNotReminded が2件
//   9) markReminded で1件目を済 → 残り1件
//   10) markReminded の冪等性（2回目はfalse）
//   11) findUpcomingEventsNeedingReminder で remaining=1 のままヒット
//   12) eventをheld化 + archive_urlセット
//   13) findHeldEventsNeedingArchivePush で当該eventが対象として返る
//   14) buildConsultationArchiveFlex の構造
//   15) getJoinedNotArchivePushed が2件
//   16) markArchivePushed で1件目を済
//   17) clearReminderArchiveTimestamps で全クリア → 再対象化
//   18) cleanup
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { getPool } = require("../src/db");
const { recordMatchingRequest } = require("../src/matching");
const {
  createEvent,
  getEvent,
  updateEventStatus,
  updateEventFields,
  inviteParticipantsFromMatchingRequests,
  setParticipantStatus,
  getJoinedNotReminded,
  markReminded,
  getJoinedNotArchivePushed,
  markArchivePushed,
  findUpcomingEventsNeedingReminder,
  findHeldEventsNeedingArchivePush,
  clearReminderArchiveTimestamps,
} = require("../src/consultation");
const {
  buildConsultationReminderFlex,
  buildConsultationArchiveFlex,
} = require("../src/flex");

const TEST_USER_PREFIX = "U_TEST_REMIND_";
const TEST_EVENT_TITLE_TAG = "[TEST_REMIND_FLOW]";

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
  console.log("=== Phase 3b-3 リマインド + アーカイブ配信 テスト ===");
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
    pass("host: " + host.company_name);

    console.log("\n[STEP 2] テストユーザー2名 + MatchingRequest 2件");
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

    console.log("\n[STEP 3] ConsultationEvent を 12時間後 confirmed で作成");
    const futureDate = new Date(Date.now() + 12 * 60 * 60 * 1000);
    eventId = await createEvent({
      hostCompanyId: host.id,
      title: TEST_EVENT_TITLE_TAG + " " + host.company_name + " リマインドテスト",
      description: "リマインドテスト用",
      scheduledAt: futureDate,
      durationMinutes: 60,
      zoomUrl: "https://zoom.us/j/test-" + Date.now(),
      capacity: 5,
      status: "confirmed",
    });
    check(typeof eventId === "number" && eventId > 0, "event created (id=" + eventId + ")");

    console.log("\n[STEP 4] invite + 2名joined");
    await inviteParticipantsFromMatchingRequests(eventId, host.id);
    await setParticipantStatus(eventId, users[0], "joined");
    await setParticipantStatus(eventId, users[1], "joined");
    const ev0 = await getEvent(eventId);
    check(ev0.participant_counts.joined === 2, "2 participants joined");

    console.log("\n[STEP 5] findUpcomingEventsNeedingReminder(24) で当該がヒット");
    const upcoming = await findUpcomingEventsNeedingReminder(24);
    const upHit = upcoming.find((e) => e.id === eventId);
    check(!!upHit, "event found in upcoming reminders");
    check(
      upHit && upHit.pending_reminders === 2,
      "pending_reminders === 2",
      "actual=" + (upHit && upHit.pending_reminders)
    );

    console.log("\n[STEP 6] buildConsultationReminderFlex の構造");
    const reminderFlex = buildConsultationReminderFlex(ev0);
    check(reminderFlex && reminderFlex.type === "flex", "reminder flex.type === 'flex'");
    check(
      reminderFlex.altText && reminderFlex.altText.indexOf("リマインド") >= 0,
      "altText contains 'リマインド'"
    );
    check(
      reminderFlex.contents.header.backgroundColor === "#E89F2A",
      "reminder header is orange-ish (#E89F2A)"
    );
    const footerBtns = reminderFlex.contents.footer && reminderFlex.contents.footer.contents;
    check(
      Array.isArray(footerBtns) && footerBtns.length >= 1 &&
      footerBtns[0].action && footerBtns[0].action.type === "uri",
      "reminder footer has 1 URI button (Zoom)"
    );

    console.log("\n[STEP 7] getJoinedNotReminded が2件");
    const r1 = await getJoinedNotReminded(eventId);
    check(r1.length === 2, "2 joined-not-reminded", "actual=" + r1.length);

    console.log("\n[STEP 8] markReminded で1件目を済 → 残り1件");
    const ok1 = await markReminded(eventId, users[0]);
    check(ok1, "markReminded returned true");
    const ok1b = await markReminded(eventId, users[0]);
    check(!ok1b, "markReminded idempotent (2nd call returns false)");
    const r2 = await getJoinedNotReminded(eventId);
    check(r2.length === 1, "1 left after markReminded");

    console.log("\n[STEP 9] eventをheld化 + archive_urlをセット");
    await updateEventStatus(eventId, "held");
    await updateEventFields(eventId, {
      archive_url: "https://example.com/archive/" + eventId,
    });
    const ev1 = await getEvent(eventId);
    check(ev1.status === "held", "event status = held");
    check(!!ev1.archive_url, "event archive_url is set");

    console.log("\n[STEP 10] findHeldEventsNeedingArchivePush で当該がヒット");
    const archList = await findHeldEventsNeedingArchivePush();
    const archHit = archList.find((e) => e.id === eventId);
    check(!!archHit, "event found in archive-push list");
    check(
      archHit && archHit.pending_archives === 2,
      "pending_archives === 2",
      "actual=" + (archHit && archHit.pending_archives)
    );

    console.log("\n[STEP 11] buildConsultationArchiveFlex の構造");
    const archiveFlex = buildConsultationArchiveFlex(ev1);
    check(archiveFlex && archiveFlex.type === "flex", "archive flex.type === 'flex'");
    check(
      archiveFlex.altText && archiveFlex.altText.indexOf("アーカイブ") >= 0,
      "altText contains 'アーカイブ'"
    );
    const archFooter = archiveFlex.contents.footer && archiveFlex.contents.footer.contents;
    check(
      Array.isArray(archFooter) && archFooter.length >= 1 &&
      archFooter[0].action && archFooter[0].action.uri === ev1.archive_url,
      "archive footer URI matches archive_url"
    );

    console.log("\n[STEP 12] getJoinedNotArchivePushed が2件");
    const a1 = await getJoinedNotArchivePushed(eventId);
    check(a1.length === 2, "2 to archive-push", "actual=" + a1.length);

    console.log("\n[STEP 13] markArchivePushed で1件目を済 → 残り1件");
    const okA1 = await markArchivePushed(eventId, users[0]);
    check(okA1, "markArchivePushed returned true");
    const okA1b = await markArchivePushed(eventId, users[0]);
    check(!okA1b, "markArchivePushed idempotent");
    const a2 = await getJoinedNotArchivePushed(eventId);
    check(a2.length === 1, "1 left after markArchivePushed");

    console.log("\n[STEP 14] clearReminderArchiveTimestamps で全クリア");
    await clearReminderArchiveTimestamps(eventId);
    const r3 = await getJoinedNotReminded(eventId);
    const a3 = await getJoinedNotArchivePushed(eventId);
    check(r3.length === 2, "all 2 are reminder-targets again after clear");
    check(a3.length === 2, "all 2 are archive-targets again after clear");

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
