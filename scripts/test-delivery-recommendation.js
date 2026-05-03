#!/usr/bin/env node
// =============================================================
// 配信フロー（recommend.js）の結合テスト
//
// 使い方:
//   node scripts/test-delivery-recommendation.js
//   node scripts/test-delivery-recommendation.js --target-initiative 19
//
// 何をするか:
//   1) テスト用 CONFIRMED ユーザー (U_TEST_DELIVERY_FLOW) を作る
//      - sales_tier='30_50' で「自社より上」のtierが多い設計
//      - profile_json に id=19 とマッチしそうな業界タグ・経営テーマを仕込む
//   2) recommend.recommendForUser() を呼ぶ（ライブDB、Claudeは呼ばない、コスト0）
//   3) status='draft' の段階では target initiative が出ないこと
//   4) 一時的に target initiative を 'published' に昇格し、推薦に入ることを確認
//   5) target initiative の status を元に戻し、テスト行を全て掃除
//
// 注意:
//  - LINE API は一切呼ばない（純粋な recommend.js 単独の検証）
//  - Initiatives.status の一時変更は最後に必ず戻す（finally で保証）
//  - --target-initiative を省略した場合は id=19（先に AI 生成したもの）
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { getPool } = require("../src/db");
const { recommendForUser } = require("../src/recommend");

const TEST_USER = "U_TEST_DELIVERY_FLOW";
const DEFAULT_TARGET_INITIATIVE_ID = 19;

function parseArgs(argv) {
  const args = { targetInitiativeId: DEFAULT_TARGET_INITIATIVE_ID };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target-initiative" && argv[i + 1]) {
      args.targetInitiativeId = parseInt(argv[++i], 10) || DEFAULT_TARGET_INITIATIVE_ID;
    } else if (a.startsWith("--target-initiative=")) {
      args.targetInitiativeId = parseInt(a.split("=")[1], 10) || DEFAULT_TARGET_INITIATIVE_ID;
    }
  }
  return args;
}

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function getInitiativeStatus(id) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id, approved_company_id, title, status FROM Initiatives WHERE id = ?",
    [id]
  );
  return rows[0] || null;
}

async function setInitiativeStatus(id, status) {
  const pool = getPool();
  await pool.execute(
    "UPDATE Initiatives SET status = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
    [status, id]
  );
}

async function cleanupTestUser() {
  const pool = getPool();
  // FK の都合で順番が大事：DeliveryLog → Profiles → MatchingRequests → Users
  await pool.execute("DELETE FROM DeliveryLog WHERE line_user_id = ?", [TEST_USER]);
  await pool.execute("DELETE FROM Profiles WHERE line_user_id = ?", [TEST_USER]);
  await pool.execute("DELETE FROM MatchingRequests WHERE line_user_id = ?", [TEST_USER]);
  await pool.execute("DELETE FROM Users WHERE line_user_id = ?", [TEST_USER]);
}

async function setupTestUser() {
  const pool = getPool();
  await cleanupTestUser();

  // 認可済企業を1社拾って approved_company_id にする
  // 自分の事例が選ばれないよう、株式会社大和(154) ではない別の会社にする
  const [rows] = await pool.execute(
    "SELECT id FROM ApprovedCompanies WHERE id <> 154 AND prefecture IS NOT NULL " +
    "AND annual_sales IS NOT NULL AND annual_sales >= 3000000000 AND annual_sales < 5000000000 " +
    "ORDER BY id LIMIT 1"
  );
  const myCompanyId = rows.length > 0 ? rows[0].id : null;

  // sales_tier='30_50' を選ぶ → 株式会社大和(50_100)が「上」になる
  await pool.execute(
    "INSERT INTO Users " +
    "(line_user_id, state, approved_company_id, sales_tier, annual_sales) " +
    "VALUES (?, 'CONFIRMED', ?, '30_50', 4000000000)",
    [TEST_USER, myCompanyId]
  );

  const profile = {
    business_summary: "テスト用：建設関連の卸売業を営んでいる中堅企業。",
    target_customers: "建設業者、住設機器販売店",
    industry_tags: ["卸売業", "建設関連"],
    management_themes: ["販路拡大", "物流・配送機能強化"],
    wanted_support_areas: ["仕入先との協働体制", "営業組織強化"],
    strengths: ["地域密着", "長年の取引関係"],
  };
  await pool.execute(
    "INSERT INTO Profiles " +
    "(line_user_id, approved_company_id, company_name, company_url, " +
    " sales_tier, annual_sales, profile_json) " +
    "VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))",
    [
      TEST_USER, myCompanyId,
      "テスト株式会社", "https://example-test.invalid/",
      "30_50", 4000000000, JSON.stringify(profile),
    ]
  );

  return { myCompanyId, profile };
}

async function main() {
  const args = parseArgs(process.argv);
  const targetId = args.targetInitiativeId;

  console.log("=== 配信フロー結合テスト ===");
  console.log("  target initiative id =", targetId);
  console.log("  test user =", TEST_USER);

  // ターゲット initiative の現在の状態を保存
  const initBefore = await getInitiativeStatus(targetId);
  if (!initBefore) {
    console.error("  ✗ ターゲット initiative id=" + targetId + " が存在しません");
    await getPool().end();
    process.exit(1);
  }
  console.log(
    "  initiative before: id=" + initBefore.id +
    ", status=" + initBefore.status +
    ", company_id=" + initBefore.approved_company_id +
    ", title=「" + initBefore.title + "」"
  );

  let restored = false;
  const restoreInitiative = async () => {
    if (restored) return;
    restored = true;
    if (initBefore.status !== "published") {
      try {
        await setInitiativeStatus(targetId, initBefore.status);
        console.log("  (cleanup) initiative status restored to '" + initBefore.status + "'");
      } catch (e) {
        console.warn("  (cleanup) initiative restore failed:", e.message);
      }
    }
  };

  try {
    // STEP 1: テストユーザー作成
    console.log("\n[STEP 1] テスト用 CONFIRMED ユーザーを作成");
    const { myCompanyId } = await setupTestUser();
    pass("test user " + TEST_USER + " created (approved_company_id=" + myCompanyId + ", tier=30_50)");

    // STEP 2: status='draft' のときは target initiative が候補に入らない
    console.log("\n[STEP 2] status='draft' で recommendForUser → target initiative は出ないこと");
    if (initBefore.status !== "draft") {
      // 既にpublishedだった場合は draft に戻して挙動確認
      await setInitiativeStatus(targetId, "draft");
    }
    const recsDraft = await recommendForUser(TEST_USER, 5);
    console.log("  recommendations under draft (" + recsDraft.length + " items):");
    for (const r of recsDraft) {
      console.log(
        "    - id=" + r.id + " score=" + r._score +
        " status?=draft? company=" + (r.company_name || "—") +
        " title=「" + r.title + "」"
      );
    }
    const draftHit = recsDraft.find((r) => r.id === targetId);
    check(!draftHit, "target initiative is NOT recommended while status='draft'");

    // STEP 3: status='published' に昇格すると候補に入る
    console.log("\n[STEP 3] status='published' に昇格 → target initiative が推薦される");
    await setInitiativeStatus(targetId, "published");
    const recsPub = await recommendForUser(TEST_USER, 5);
    console.log("  recommendations under published (" + recsPub.length + " items):");
    for (const r of recsPub) {
      console.log(
        "    - id=" + r.id + " score=" + r._score +
        " company=" + (r.company_name || "—") +
        " title=「" + r.title + "」" +
        " reasons=" + JSON.stringify(r._reasons)
      );
    }
    const pubHit = recsPub.find((r) => r.id === targetId);
    check(!!pubHit, "target initiative is now recommended");
    if (pubHit) {
      check(pubHit._score > 0, "score > 0 (= some industry/theme/interest match)", "score=" + pubHit._score);
      check(
        pubHit._reasons &&
          ((pubHit._reasons.industries && pubHit._reasons.industries.length > 0) ||
            (pubHit._reasons.themes && pubHit._reasons.themes.length > 0)),
        "match reasons include at least one industry or theme"
      );
    }

    // STEP 4: status を元に戻す
    console.log("\n[STEP 4] target initiative の status を元に戻す");
    await setInitiativeStatus(targetId, initBefore.status);
    restored = true;
    const initAfter = await getInitiativeStatus(targetId);
    check(
      initAfter && initAfter.status === initBefore.status,
      "initiative status restored to '" + initBefore.status + "'",
      "actual=" + (initAfter && initAfter.status)
    );

    // STEP 5: テストユーザーを掃除
    console.log("\n[STEP 5] テストユーザーをクリーンアップ");
    await cleanupTestUser();
    const pool = getPool();
    const [check1] = await pool.execute(
      "SELECT COUNT(*) AS n FROM Users WHERE line_user_id = ?",
      [TEST_USER]
    );
    check(check1[0].n === 0, "test user removed from Users");
    const [check2] = await pool.execute(
      "SELECT COUNT(*) AS n FROM Profiles WHERE line_user_id = ?",
      [TEST_USER]
    );
    check(check2[0].n === 0, "test user removed from Profiles");

    console.log("\n=== 結果: " + passed + " passed, " + failed + " failed ===");
  } catch (err) {
    console.error("[test] fatal:", err);
    failed++;
  } finally {
    await restoreInitiative();
    try { await cleanupTestUser(); } catch (_e) {}
    await getPool().end();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
