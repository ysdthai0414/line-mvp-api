#!/usr/bin/env node
// =============================================================
// 同名衝突 → 都道府県選択 フローの手動テストスクリプト
//
// 使い方:
//   node scripts/test-prefecture-flow.js
//
// 何をするか:
//  1) ApprovedCompanies から「同名（normalized）の企業ペア」を1組見つける
//  2) findApprovedCompanies / findApprovedCompaniesWithPrefecture を呼んで
//     候補件数・絞り込み件数が期待通りかを確認
//  3) onboarding.checkApproval / resolveByPrefecture / uniquePrefectures を
//     呼んで戻り値の形を確認
//  4) handlers の中身を直接呼ばず、純粋関数のみで検証する
//     （LINE API は呼ばないので Channel Token 不要）
//  5) Users テーブルへの書き込み（saveAwaitingPrefecture / getPendingCompanyInput
//     / discardPendingProfile）も検証する。テスト用ダミー line_user_id を
//     使い、終わったらクリーンアップ
//
// 注意:
//  - DB に接続するので .env の MYSQL_* と Azure FW 許可が必要
//  - 認可マスタは読み取りのみ。書き込むのは Users テーブルのテスト行のみ
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const {
  getPool,
  findApprovedCompanies,
  findApprovedCompaniesWithPrefecture,
  saveAwaitingPrefecture,
  getPendingCompanyInput,
  discardPendingProfile,
} = require("../src/db");
const {
  checkApproval,
  resolveByPrefecture,
  uniquePrefectures,
} = require("../src/onboarding");
const { buildPrefectureQuickReply } = require("../src/flex");

const TEST_LINE_USER_ID = "U_TEST_PREFECTURE_FLOW";

let passed = 0;
let failed = 0;

function pass(name) {
  passed++;
  console.log("  ✓ " + name);
}
function fail(name, detail) {
  failed++;
  console.log("  ✗ " + name + (detail ? " — " + detail : ""));
}
function check(cond, name, detail) {
  if (cond) pass(name);
  else fail(name, detail);
}

async function findSameNamePair() {
  const pool = getPool();
  // a.id < b.id で同 normalized name のペアを1組
  const [rows] = await pool.execute(
    "SELECT a.company_name_normalized AS norm, " +
    "       a.id AS id_a, a.company_name AS name_a, a.prefecture AS pref_a, " +
    "       b.id AS id_b, b.company_name AS name_b, b.prefecture AS pref_b " +
    "FROM ApprovedCompanies a " +
    "JOIN ApprovedCompanies b " +
    "  ON a.company_name_normalized = b.company_name_normalized " +
    " AND a.id < b.id " +
    "WHERE a.prefecture IS NOT NULL AND b.prefecture IS NOT NULL " +
    "  AND a.prefecture <> b.prefecture " +
    "ORDER BY a.id LIMIT 1"
  );
  return rows.length > 0 ? rows[0] : null;
}

async function ensureCleanUser() {
  const pool = getPool();
  await pool.execute(
    "DELETE FROM Users WHERE line_user_id = ?",
    [TEST_LINE_USER_ID]
  );
}

async function main() {
  console.log("=== 同名衝突 → 都道府県フロー テスト ===\n");

  console.log("[STEP 0] テスト用 Users 行をクリーンアップ");
  await ensureCleanUser();
  pass("clean up test user");

  console.log("\n[STEP 1] 同名（異なる都道府県）のペアを認可マスタから1組取得");
  const pair = await findSameNamePair();
  if (!pair) {
    console.log("  → ペアが見つかりませんでした。");
    console.log("    全候補の都道府県が同一か NULL なため、別の経路で確認してください。");
    fail("find same-name pair (different prefectures)");
    await getPool().end();
    process.exit(1);
  }
  console.log("  pair:", pair);
  pass("found same-name pair: " + pair.name_a + " / " + pair.name_b);

  console.log("\n[STEP 2] findApprovedCompanies / Pure 正規化マッチ件数 ≥ 2");
  const candidates = await findApprovedCompanies(pair.norm);
  check(
    candidates.length >= 2,
    "findApprovedCompanies returns >= 2 rows",
    "actual=" + candidates.length
  );

  console.log("\n[STEP 3] checkApproval で ambiguous=true / allCandidates ≥ 2");
  // 現実的な入力例（株式会社プレフィックス付き）にしてみる
  const inputName = "株式会社" + pair.name_a.replace(/^株式会社/, "");
  const approval = await checkApproval(inputName);
  check(approval.matched === true, "approval.matched is true");
  check(approval.ambiguous === true, "approval.ambiguous is true");
  check(
    Array.isArray(approval.allCandidates) && approval.allCandidates.length >= 2,
    "approval.allCandidates >= 2",
    "actual=" + (approval.allCandidates ? approval.allCandidates.length : "n/a")
  );

  console.log("\n[STEP 4] uniquePrefectures で都道府県をユニーク化");
  const prefectures = uniquePrefectures(approval.allCandidates);
  console.log("  prefectures:", prefectures);
  check(prefectures.length >= 2, "unique prefectures >= 2");

  console.log("\n[STEP 5] buildPrefectureQuickReply の構造チェック");
  const qr = buildPrefectureQuickReply(prefectures);
  check(qr && Array.isArray(qr.items), "QR has items array");
  // 都道府県分 + やり直す1件
  check(
    qr.items.length === prefectures.length + 1,
    "QR items count = prefectures + 1 (retry)",
    "actual=" + (qr.items ? qr.items.length : "n/a")
  );
  const retryItem = qr.items[qr.items.length - 1];
  check(
    retryItem &&
      retryItem.action &&
      retryItem.action.data === "action=retry",
    "last QR item is retry"
  );
  const firstItem = qr.items[0];
  const decodedFirst =
    firstItem &&
    firstItem.action &&
    decodeURIComponent(
      (firstItem.action.data || "").replace(/^action=prefecture&value=/, "")
    );
  check(
    decodedFirst === prefectures[0],
    "first QR item encodes first prefecture correctly"
  );

  console.log("\n[STEP 6] saveAwaitingPrefecture で Users 行を作る");
  await saveAwaitingPrefecture(
    TEST_LINE_USER_ID,
    inputName,
    "https://example-test.invalid/"
  );
  const pending = await getPendingCompanyInput(TEST_LINE_USER_ID);
  check(
    pending && pending.state === "AWAITING_PREFECTURE",
    "user state = AWAITING_PREFECTURE",
    "actual=" + (pending && pending.state)
  );
  check(
    pending && pending.companyName === inputName,
    "pending companyName preserved"
  );
  check(
    pending && pending.companyUrl === "https://example-test.invalid/",
    "pending companyUrl preserved"
  );

  console.log("\n[STEP 7] resolveByPrefecture で1社に特定");
  const resolved = await resolveByPrefecture(inputName, pair.pref_a);
  check(resolved.matched === true, "resolved.matched is true");
  check(
    resolved.candidate && resolved.candidate.prefecture === pair.pref_a,
    "resolved.candidate.prefecture matches",
    "actual=" + (resolved.candidate && resolved.candidate.prefecture)
  );
  // ペアのうち反対側を選んだら別の id になることも確認
  const resolvedB = await resolveByPrefecture(inputName, pair.pref_b);
  check(
    resolvedB.matched === true,
    "resolveByPrefecture works for the other prefecture too"
  );
  check(
    resolved.candidate &&
      resolvedB.candidate &&
      resolved.candidate.id !== resolvedB.candidate.id,
    "resolveByPrefecture distinguishes the two candidates"
  );

  console.log("\n[STEP 8] resolveByPrefecture で都道府県違い（0件）");
  const noMatch = await resolveByPrefecture(inputName, "存在しない県");
  check(noMatch.matched === false, "no match for unknown prefecture");

  console.log("\n[STEP 9] discardPendingProfile で state=NEW にリセット");
  await discardPendingProfile(TEST_LINE_USER_ID);
  const after = await getPendingCompanyInput(TEST_LINE_USER_ID);
  check(after && after.state === "NEW", "state reset to NEW");
  check(
    after && after.companyName === null,
    "pending companyName cleared"
  );

  console.log("\n[STEP 10] テストデータをクリーンアップ");
  await ensureCleanUser();
  pass("test user removed");

  console.log("\n=== 結果: " + passed + " passed, " + failed + " failed ===");
  await getPool().end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(1);
});
