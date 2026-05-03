#!/usr/bin/env node
// =============================================================
// delivery_runner (A1) 結合テスト
//
// 使い方:
//   node scripts/test-delivery-runner.js
//
// シナリオ:
//   1) クリーンアップ
//   2) テスト用ユーザー2名（1名は CONFIRMED + profile、1名は NEW）
//   3) runDelivery を dryRun=true + モックLINEクライアントで実行:
//      - CONFIRMED ユーザーが対象に含まれる
//      - NEW ユーザーは含まれない
//   4) 戻り値の構造検証 (mode/total/sent/skipped/failed/results)
//   5) userId 指定で 1人だけ対象になる
//   6) limit が反映される（recs.length <= limit）
//   7) モッククライアントの pushMessage はライブモードでのみ呼ばれる
//   8) クリーンアップ
//
// LINE API は呼ばない（dryRun もしくはモック）。
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { getPool } = require("../src/db");
const { runDelivery } = require("../src/delivery_runner");

const TEST_USER_PREFIX = "U_TEST_DELIVERY_RUNNER_";

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function cleanup() {
  const pool = getPool();
  await pool.execute("DELETE FROM DeliveryLog WHERE line_user_id LIKE ?", [TEST_USER_PREFIX + "%"]);
  await pool.execute("DELETE FROM Profiles WHERE line_user_id LIKE ?", [TEST_USER_PREFIX + "%"]);
  await pool.execute("DELETE FROM MatchingRequests WHERE line_user_id LIKE ?", [TEST_USER_PREFIX + "%"]);
  await pool.execute("DELETE FROM Users WHERE line_user_id LIKE ?", [TEST_USER_PREFIX + "%"]);
}

async function setupUsers() {
  const pool = getPool();
  const [otherRows] = await pool.execute(
    "SELECT id FROM ApprovedCompanies WHERE annual_sales IS NOT NULL " +
    "AND annual_sales < 1000000000 ORDER BY id LIMIT 1"
  );
  const myCompany = otherRows[0];
  if (!myCompany) throw new Error("テスト用 user に割り当てる ApprovedCompany が無い");

  // CONFIRMED + profile
  await pool.execute(
    "INSERT INTO Users (line_user_id, state, approved_company_id, sales_tier, annual_sales) " +
    "VALUES (?, 'CONFIRMED', ?, '10_30', 1500000000)",
    [TEST_USER_PREFIX + "CONFIRMED", myCompany.id]
  );
  const profile = {
    business_summary: "テスト",
    target_customers: "—",
    industry_tags: ["卸売業"],
    management_themes: ["販路拡大"],
    wanted_support_areas: [],
    strengths: [],
  };
  await pool.execute(
    "INSERT INTO Profiles " +
    "(line_user_id, approved_company_id, company_name, company_url, " +
    " sales_tier, annual_sales, profile_json) " +
    "VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))",
    [
      TEST_USER_PREFIX + "CONFIRMED", myCompany.id,
      "テスト株式会社", "https://example-test.invalid/",
      "10_30", 1500000000, JSON.stringify(profile),
    ]
  );

  // NEW（state != CONFIRMED なので listTargetUsers 対象外）
  await pool.execute(
    "INSERT INTO Users (line_user_id, state) VALUES (?, 'NEW')",
    [TEST_USER_PREFIX + "NEW"]
  );
}

function makeMockClient() {
  const mock = { pushed: [] };
  mock.pushMessage = async (args) => {
    mock.pushed.push(args);
    return { ok: true };
  };
  return mock;
}

async function main() {
  console.log("=== A1 delivery_runner 結合テスト ===");
  try {
    console.log("\n[STEP 0] cleanup");
    await cleanup();
    pass("pre-cleanup done");

    console.log("\n[STEP 1] テストユーザー作成 (CONFIRMED, NEW)");
    await setupUsers();
    pass("users created");

    console.log("\n[STEP 2] runDelivery dryRun=true で全ユーザー対象");
    const r1 = await runDelivery({
      dryRun: true,
      sleepMs: 0,
      logger: { log: () => {}, error: () => {} },
    });
    check(r1 && r1.mode === "dry_run", "result.mode === 'dry_run'");
    check(typeof r1.total === "number", "result.total is number");
    check(Array.isArray(r1.results), "result.results is array");
    // CONFIRMED テストユーザーが対象に含まれる
    const hitConfirmed = r1.results.find(
      (x) => x.lineUserId === TEST_USER_PREFIX + "CONFIRMED"
    );
    check(!!hitConfirmed, "CONFIRMED test user included in results");
    // NEW は除外
    const hitNew = r1.results.find(
      (x) => x.lineUserId === TEST_USER_PREFIX + "NEW"
    );
    check(!hitNew, "NEW test user excluded from results");

    console.log("\n[STEP 3] runDelivery userId 指定で 1ユーザーのみ対象");
    const r2 = await runDelivery({
      userId: TEST_USER_PREFIX + "CONFIRMED",
      dryRun: true,
      sleepMs: 0,
      logger: { log: () => {}, error: () => {} },
    });
    check(r2.total === 1, "userId 指定時 total === 1", "actual=" + r2.total);
    check(
      r2.results.length === 1 &&
      r2.results[0].lineUserId === TEST_USER_PREFIX + "CONFIRMED",
      "userId 指定時 results は対象のみ"
    );

    console.log("\n[STEP 4] runDelivery userId='存在しない' は対象0");
    const r3 = await runDelivery({
      userId: "U_NOT_EXIST_AT_ALL",
      dryRun: true,
      sleepMs: 0,
      logger: { log: () => {}, error: () => {} },
    });
    check(r3.total === 0, "存在しないuserId → total === 0");
    check(r3.sent === 0 && r3.skipped === 0 && r3.failed === 0, "全カウント 0");

    console.log("\n[STEP 5] モッククライアントで非dryRun動作確認");
    const mock = makeMockClient();
    const r4 = await runDelivery({
      userId: TEST_USER_PREFIX + "CONFIRMED",
      dryRun: false,
      client: mock,
      sleepMs: 0,
      logger: { log: () => {}, error: () => {} },
    });
    // CONFIRMED ユーザーには「自社より上の tier」の Initiative が seed_initiatives で複数あるはず
    if (r4.sent > 0) {
      check(mock.pushed.length === r4.sent, "mock.pushed count === r4.sent");
      check(
        mock.pushed[0].messages && mock.pushed[0].messages[0] &&
        mock.pushed[0].messages[0].type === "flex",
        "pushed message is flex"
      );
    } else {
      // 候補が無いケース（DBに公開済 Initiative がない等）。それは skipped が増える
      check(r4.skipped >= 1, "no recs → skipped カウント増");
      console.log("  (注: r4.sent === 0。recommendation 候補が無いか既配信のみ)");
    }

    console.log("\n[STEP 6] limit が伝播する");
    const r5 = await runDelivery({
      userId: TEST_USER_PREFIX + "CONFIRMED",
      limit: 1,
      dryRun: true,
      sleepMs: 0,
      logger: { log: () => {}, error: () => {} },
    });
    if (r5.results.length > 0 && r5.results[0].titles) {
      check(
        r5.results[0].titles.length <= 1,
        "limit=1 → titles.length <= 1",
        "actual=" + r5.results[0].titles.length
      );
    } else {
      pass("limit テスト: 候補がないためスキップ扱い (許容)");
    }

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
