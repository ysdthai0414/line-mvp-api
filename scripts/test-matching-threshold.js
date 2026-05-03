#!/usr/bin/env node
// =============================================================
// マッチングしきい値検知 + 通知 結合テスト
//
// 使い方:
//   node scripts/test-matching-threshold.js
//
// 何をするか:
//  1) テスト用の認可企業1社（実DBから1社拝借、ID保持）
//  2) テスト用 CONFIRMED ユーザー N 人を作成（テスト用 line_user_id プレフィックス）
//  3) 各ユーザーが target 会社に MatchingRequest を発行（pending）
//  4) findCompaniesAboveThreshold(N) → target 会社が含まれることを確認
//  5) wasNotifiedRecently(target) → 初回 false
//  6) sendNotification(dryRun=true) → 正しいペイロードが返る
//  7) recordNotification(...) で履歴記録
//  8) wasNotifiedRecently(target) → 直後 true（重複抑制が効くこと）
//  9) すべてのテストレコードを削除（finally で必ずクリーンアップ）
//
// 注意:
//  - LINE API / Slack Webhook は呼ばない（dryRun=true）
//  - 既存データ（実ユーザー・実申請）には触らない（テスト用 line_user_id でフィルタ）
//  - target 認可企業の MatchingRequests/Notifications だけ取り除く
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { getPool } = require("../src/db");
const {
  recordMatchingRequest,
  findCompaniesAboveThreshold,
  wasNotifiedRecently,
  recordNotification,
  getRecentNotifications,
} = require("../src/matching");
const { sendNotification } = require("../src/notify");

const TEST_THRESHOLD = 3;
const TEST_USER_COUNT = 3;
const TEST_USER_PREFIX = "U_TEST_THRESHOLD_";

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function pickTestCompany() {
  const pool = getPool();
  // テストに使う認可企業を1社確保（既存pending申請が0件のものを優先）
  const [rows] = await pool.execute(
    "SELECT ac.id, ac.company_name, ac.prefecture " +
    "FROM ApprovedCompanies ac " +
    "LEFT JOIN MatchingRequests mr " +
    "  ON mr.target_approved_company_id = ac.id AND mr.status = 'pending' " +
    "WHERE ac.prefecture IS NOT NULL " +
    "GROUP BY ac.id, ac.company_name, ac.prefecture " +
    "HAVING COUNT(mr.id) = 0 " +
    "ORDER BY ac.id LIMIT 1"
  );
  return rows[0] || null;
}

async function cleanup(targetCompanyId) {
  const pool = getPool();
  // テストユーザーの MatchingRequests を削除
  await pool.execute(
    "DELETE FROM MatchingRequests WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  // テストユーザーの Profiles, DeliveryLog
  await pool.execute(
    "DELETE FROM DeliveryLog WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  await pool.execute(
    "DELETE FROM Profiles WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  // テストユーザーを削除
  await pool.execute(
    "DELETE FROM Users WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  // テスト中に作った Notification 履歴も削除（target_companyに対するものだけ、テスト中の expected_threshold で）
  if (targetCompanyId) {
    await pool.execute(
      "DELETE FROM MatchingNotifications " +
      "WHERE target_approved_company_id = ? AND threshold_value = ?",
      [targetCompanyId, TEST_THRESHOLD]
    );
  }
}

async function setupTestUsers(approvedCompanyId, n) {
  const pool = getPool();
  for (let i = 1; i <= n; i++) {
    const lineUserId = TEST_USER_PREFIX + i;
    await pool.execute(
      "INSERT INTO Users (line_user_id, state, approved_company_id, sales_tier, annual_sales) " +
      "VALUES (?, 'CONFIRMED', ?, '10_30', 1500000000)",
      [lineUserId, approvedCompanyId]
    );
  }
}

async function main() {
  console.log("=== Phase 3a しきい値検知 + 通知 結合テスト ===");

  const target = await pickTestCompany();
  if (!target) {
    console.error("  ✗ テスト用に使える認可企業が見つからない（pending=0件のもの）");
    await getPool().end();
    process.exit(1);
  }
  console.log(
    "  target: id=" + target.id +
    " name=" + target.company_name +
    " prefecture=" + target.prefecture
  );

  try {
    // クリーンアップ（前回の残骸を消す）
    console.log("\n[STEP 0] 既存テストデータをクリーンアップ");
    await cleanup(target.id);
    pass("pre-cleanup done");

    // STEP 1: テストユーザー N 人作成
    console.log("\n[STEP 1] テストユーザーを " + TEST_USER_COUNT + " 人作成");
    await setupTestUsers(target.id, TEST_USER_COUNT);
    const pool = getPool();
    const [userCheck] = await pool.execute(
      "SELECT COUNT(*) AS n FROM Users WHERE line_user_id LIKE ?",
      [TEST_USER_PREFIX + "%"]
    );
    check(
      userCheck[0].n === TEST_USER_COUNT,
      "test users created (count=" + userCheck[0].n + ")"
    );

    // STEP 2: 各ユーザーが target 会社に申請
    console.log("\n[STEP 2] 各テストユーザーが target 会社に「話を聞きたい」を発行");
    for (let i = 1; i <= TEST_USER_COUNT; i++) {
      await recordMatchingRequest({
        lineUserId: TEST_USER_PREFIX + i,
        targetCompanyId: target.id,
        sourceInitiativeId: null,
      });
    }
    const [reqCheck] = await pool.execute(
      "SELECT COUNT(*) AS n FROM MatchingRequests " +
      "WHERE target_approved_company_id = ? AND status = 'pending' " +
      "  AND line_user_id LIKE ?",
      [target.id, TEST_USER_PREFIX + "%"]
    );
    check(
      reqCheck[0].n === TEST_USER_COUNT,
      "matching requests created (count=" + reqCheck[0].n + ")"
    );

    // STEP 3: しきい値検知に target が含まれること
    console.log("\n[STEP 3] findCompaniesAboveThreshold で target が含まれることを確認");
    const above = await findCompaniesAboveThreshold(TEST_THRESHOLD);
    const hit = above.find((c) => c.company_id === target.id);
    check(!!hit, "target found in above-threshold list");
    if (hit) {
      check(
        hit.offer_count >= TEST_THRESHOLD,
        "offer_count >= threshold",
        "actual=" + hit.offer_count
      );
      check(
        hit.requester_count === TEST_USER_COUNT,
        "requester_count = TEST_USER_COUNT",
        "actual=" + hit.requester_count
      );
    }

    // STEP 4: 初回は通知済とみなされない
    console.log("\n[STEP 4] wasNotifiedRecently は初回 false");
    const recent1 = await wasNotifiedRecently(target.id);
    check(!recent1, "wasNotifiedRecently is false before any notification");

    // STEP 5: dry-run で通知ペイロードを組み立てる
    console.log("\n[STEP 5] sendNotification(dryRun=true) で payload を取得");
    const notify = await sendNotification({
      title: "TEST: " + target.company_name + " の申請が " + TEST_USER_COUNT + " 件に到達",
      summary: "テスト用通知",
      fields: { 件数: TEST_USER_COUNT, company_id: target.id },
      dryRun: true,
    });
    check(notify.ok, "sendNotification returned ok=true");
    check(notify.dryRun === true, "result.dryRun is true");
    check(
      notify.channel === "slack" || notify.channel === "console",
      "channel is slack or console (channel=" + notify.channel + ")"
    );

    // STEP 6: 通知履歴を記録
    console.log("\n[STEP 6] recordNotification で履歴を記録");
    await recordNotification({
      targetCompanyId: target.id,
      pendingCount: TEST_USER_COUNT,
      threshold: TEST_THRESHOLD,
      channel: notify.channel,
      status: "logged", // dryRun なので logged 扱い
      payload: notify.payload,
    });
    const recent2 = await wasNotifiedRecently(target.id);
    check(recent2, "wasNotifiedRecently is true after recording");

    // STEP 7: 履歴を取得して確認
    console.log("\n[STEP 7] getRecentNotifications で履歴の中身を確認");
    const hist = await getRecentNotifications(target.id, 5);
    check(hist.length >= 1, "history has >=1 row");
    if (hist.length > 0) {
      check(
        hist[0].pending_count_at_notify === TEST_USER_COUNT,
        "pending_count_at_notify = TEST_USER_COUNT",
        "actual=" + hist[0].pending_count_at_notify
      );
      check(
        hist[0].threshold_value === TEST_THRESHOLD,
        "threshold_value = TEST_THRESHOLD",
        "actual=" + hist[0].threshold_value
      );
      check(
        hist[0].status === "logged",
        "status = logged",
        "actual=" + hist[0].status
      );
    }

    console.log("\n=== 結果: " + passed + " passed, " + failed + " failed ===");
  } catch (err) {
    console.error("[test] fatal:", err);
    failed++;
  } finally {
    console.log("\n[STEP 8] クリーンアップ");
    try {
      await cleanup(target.id);
      console.log("  ✓ cleanup done");
    } catch (e) {
      console.warn("  ✗ cleanup failed:", e.message);
    }
    await getPool().end();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
