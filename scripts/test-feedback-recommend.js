#!/usr/bin/env node
// =============================================================
// Phase 6 配信フィードバック → レコメンド改善 結合テスト
//
// 使い方:
//   node scripts/test-feedback-recommend.js
//
// シナリオ:
//   1) クリーンアップ
//   2) テスト用 CONFIRMED ユーザー作成 (sales_tier='30_50')
//      profile_json は意図的に「業界もテーマも一致しない」内容にする
//      → industry/theme/interest スコアは 0、フィードバックの影響だけが score を動かす
//   3) 候補となる Initiatives を一時的に作成（status='published'）:
//      - DX カテゴリの事例 (5件)
//      - M&A カテゴリの事例 (3件)
//      - 販路拡大カテゴリの事例 (1件)
//      すべて user の sales_tier より上のフェーズになるよう host_company を選ぶ
//   4) 過去の DeliveryLog を仕込む:
//      DX のうち 3件 → helpful
//      M&A のうち 2件 → not_helpful
//      販路拡大 → feedback null（無関与）
//   5) getCategoryFeedbackBias の戻り値を検証:
//      { "DX": +3, "M&A": -2 } になること
//   6) recommendForUser を呼び（既配信は除外されるので、helpful/notHelpfulとは別の未配信4件が候補）:
//      DX 2件 (未配信) score=+3
//      M&A 1件 (未配信) score=-2
//      販路拡大 1件 (未配信) score=0
//      → 並び順: DX(2) → 販路拡大 → M&A
//      score 反映を確認
//   7) reasons.feedbackBias が正しく入っていること
//   8) クリーンアップ（テストデータ全削除）
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const {
  getPool,
  getCategoryFeedbackBias,
} = require("../src/db");
const { recommendForUser, scoreInitiative } = require("../src/recommend");

const TEST_USER = "U_TEST_FEEDBACK_RECO";
const TEST_INIT_TAG = "[TEST_FEEDBACK_RECO]";

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function cleanup() {
  const pool = getPool();
  await pool.execute(
    "DELETE FROM DeliveryLog WHERE line_user_id = ?",
    [TEST_USER]
  );
  await pool.execute(
    "DELETE FROM Profiles WHERE line_user_id = ?",
    [TEST_USER]
  );
  await pool.execute(
    "DELETE FROM MatchingRequests WHERE line_user_id = ?",
    [TEST_USER]
  );
  await pool.execute(
    "DELETE FROM Users WHERE line_user_id = ?",
    [TEST_USER]
  );
  // テスト用 Initiatives も掃除（titleに識別タグ）
  await pool.execute(
    "DELETE FROM Initiatives WHERE title LIKE ?",
    ["%" + TEST_INIT_TAG + "%"]
  );
}

async function pickHigherTierCompany() {
  // テスト user を 30_50 にするので、それより上 (50_100 or OVER_100) の company を host にする
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id FROM ApprovedCompanies " +
    "WHERE annual_sales IS NOT NULL AND annual_sales >= 5000000000 " +
    "ORDER BY id LIMIT 1"
  );
  return rows[0] || null;
}

async function pickLowerTierCompany() {
  // user の approved_company_id 用（own company は recommend から除外される）。
  // 無関係な会社（30_50 帯ではない方が安全）。
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id FROM ApprovedCompanies " +
    "WHERE annual_sales IS NOT NULL AND annual_sales < 1000000000 " +
    "ORDER BY id LIMIT 1"
  );
  return rows[0] || null;
}

async function createInitiative(hostCompanyId, category, suffix) {
  const pool = getPool();
  const [r] = await pool.execute(
    "INSERT INTO Initiatives " +
    "(approved_company_id, title, summary, category, " +
    " industry_tags, target_themes, bullet_points, status, source) " +
    "VALUES (?, ?, ?, ?, " +
    " CAST('[\"非マッチ業界\"]' AS JSON), CAST('[\"非マッチテーマ\"]' AS JSON), " +
    " CAST('[]' AS JSON), 'published', 'test')",
    [
      hostCompanyId,
      TEST_INIT_TAG + " " + category + " #" + suffix,
      "テスト用 Initiative",
      category,
    ]
  );
  return r.insertId;
}

async function main() {
  console.log("=== Phase 6 フィードバック → レコメンド改善 結合テスト ===");

  let createdIds = [];
  try {
    console.log("\n[STEP 0] cleanup");
    await cleanup();
    pass("pre-cleanup done");

    console.log("\n[STEP 1] テスト用ユーザー作成 (tier=30_50, 業界/テーマ非マッチの profile)");
    const myCompany = await pickLowerTierCompany();
    const hostCompany = await pickHigherTierCompany();
    if (!myCompany || !hostCompany) {
      throw new Error("テスト用の会社が DB から取得できません");
    }
    const pool = getPool();
    await pool.execute(
      "INSERT INTO Users " +
      "(line_user_id, state, approved_company_id, sales_tier, annual_sales) " +
      "VALUES (?, 'CONFIRMED', ?, '30_50', 4000000000)",
      [TEST_USER, myCompany.id]
    );
    const profileJson = {
      business_summary: "テスト用",
      target_customers: "—",
      industry_tags: ["完全に重ならない業界"],
      management_themes: ["完全に重ならないテーマ"],
      wanted_support_areas: [],
      strengths: [],
    };
    await pool.execute(
      "INSERT INTO Profiles " +
      "(line_user_id, approved_company_id, company_name, company_url, " +
      " sales_tier, annual_sales, profile_json) " +
      "VALUES (?, ?, 'テスト株式会社', 'https://example-test.invalid/', " +
      "        '30_50', 4000000000, CAST(? AS JSON))",
      [TEST_USER, myCompany.id, JSON.stringify(profileJson)]
    );
    pass("user + profile created");

    console.log("\n[STEP 2] テスト用 Initiatives を作成");
    // DX 5件
    const dxIds = [];
    for (let i = 1; i <= 5; i++) {
      dxIds.push(await createInitiative(hostCompany.id, "DX", i));
    }
    // M&A 3件
    const maIds = [];
    for (let i = 1; i <= 3; i++) {
      maIds.push(await createInitiative(hostCompany.id, "M&A", i));
    }
    // 販路拡大 1件
    const hanroIds = [await createInitiative(hostCompany.id, "販路拡大", 1)];
    createdIds = [...dxIds, ...maIds, ...hanroIds];
    pass("initiatives created (DX×5, M&A×3, 販路拡大×1)");

    console.log("\n[STEP 3] DeliveryLog 仕込み");
    // DX 3件 helpful
    for (let i = 0; i < 3; i++) {
      await pool.execute(
        "INSERT INTO DeliveryLog (line_user_id, initiative_id, feedback) " +
        "VALUES (?, ?, 'helpful')",
        [TEST_USER, dxIds[i]]
      );
    }
    // M&A 2件 not_helpful
    for (let i = 0; i < 2; i++) {
      await pool.execute(
        "INSERT INTO DeliveryLog (line_user_id, initiative_id, feedback) " +
        "VALUES (?, ?, 'not_helpful')",
        [TEST_USER, maIds[i]]
      );
    }
    pass("DeliveryLog seeded (DX×3 helpful, M&A×2 not_helpful)");

    console.log("\n[STEP 4] getCategoryFeedbackBias 検証");
    const bias = await getCategoryFeedbackBias(TEST_USER);
    console.log("  bias:", bias);
    check(bias["DX"] === 3, "bias.DX === +3", "actual=" + bias["DX"]);
    check(bias["M&A"] === -2, "bias['M&A'] === -2", "actual=" + bias["M&A"]);
    check(!("販路拡大" in bias), "bias has no '販路拡大' (no feedback)");

    console.log("\n[STEP 5] recommendForUser を呼ぶ");
    const recsAll = await recommendForUser(TEST_USER, 50);
    console.log("  recsAll (id, score, category, feedbackBias):");
    for (const r of recsAll) {
      console.log(
        "    - id=" + r.id + " score=" + r._score + " category=" + r.category +
        " feedbackBias=" + (r._reasons && r._reasons.feedbackBias)
      );
    }

    // 注意: DBには seed_initiatives.sql 等の既存 published データが居る場合がある。
    // そのため、テスト assertion は「自前で作ったIDセット」だけに絞り込んで検証する。
    const testIdSet = new Set(createdIds);
    const recs = recsAll.filter((r) => testIdSet.has(r.id));

    // 5件配信済(DX 3 + M&A 2) なので、テスト由来の未配信は DX 2 + M&A 1 + 販路拡大 1 = 4件
    check(recs.length === 4, "4 test-owned candidates (5 already delivered)", "actual=" + recs.length);

    const dxRecs = recs.filter((r) => r.category === "DX");
    const maRecs = recs.filter((r) => r.category === "M&A");
    const hanroRecs = recs.filter((r) => r.category === "販路拡大");
    check(dxRecs.length === 2, "DX 2件残（テスト由来のみ）");
    check(maRecs.length === 1, "M&A 1件残（テスト由来のみ）");
    check(hanroRecs.length === 1, "販路拡大 1件残（テスト由来のみ）");

    if (dxRecs[0]) check(dxRecs[0]._score === 3, "DX score === 3", "actual=" + dxRecs[0]._score);
    if (maRecs[0]) check(maRecs[0]._score === -2, "M&A score === -2", "actual=" + maRecs[0]._score);
    if (hanroRecs[0]) check(hanroRecs[0]._score === 0, "販路拡大 score === 0", "actual=" + hanroRecs[0]._score);

    // 並び順検証は「テスト由来IDのみで見たカテゴリ順位」で行う
    // 期待: DX(+3)×2 → 販路拡大(0) → M&A(-2)
    check(
      recs[0] && recs[0].category === "DX" && recs[1] && recs[1].category === "DX",
      "top 2 (test-owned) are DX"
    );
    check(recs[2] && recs[2].category === "販路拡大", "3rd (test-owned) is 販路拡大");
    check(recs[3] && recs[3].category === "M&A", "4th (test-owned) is M&A");

    // ボーナス検証: seed 由来の DX/M&A にも feedbackBias が反映されているか確認
    const seedDxHit = recsAll.find((r) => r.category === "DX" && !testIdSet.has(r.id));
    const seedMaHit = recsAll.find((r) => r.category === "M&A" && !testIdSet.has(r.id));
    if (seedDxHit) {
      check(
        seedDxHit._reasons && seedDxHit._reasons.feedbackBias === 3,
        "seed DX initiative also gets feedbackBias === 3 (cross-cutting)"
      );
    }
    if (seedMaHit) {
      check(
        seedMaHit._reasons && seedMaHit._reasons.feedbackBias === -2,
        "seed M&A initiative also gets feedbackBias === -2 (cross-cutting)"
      );
    }

    console.log("\n[STEP 6] reasons.feedbackBias の中身確認");
    if (dxRecs[0]) {
      check(
        dxRecs[0]._reasons && dxRecs[0]._reasons.feedbackBias === 3,
        "DX rec has reasons.feedbackBias === 3"
      );
    }
    if (maRecs[0]) {
      check(
        maRecs[0]._reasons && maRecs[0]._reasons.feedbackBias === -2,
        "M&A rec has reasons.feedbackBias === -2"
      );
    }
    if (hanroRecs[0]) {
      check(
        hanroRecs[0]._reasons && hanroRecs[0]._reasons.feedbackBias === 0,
        "販路拡大 rec has reasons.feedbackBias === 0"
      );
    }

    console.log("\n[STEP 7] scoreInitiative の単体検証（feedbackBiasのみ）");
    const fakeCtx = {
      lineUserId: TEST_USER,
      salesTier: "30_50",
      annualSales: 4000000000,
      approvedCompanyId: 999999, // own除外検証は別途
      profile: { industry_tags: [], management_themes: [] },
      interests: [],
      dislikedCategories: [],
      feedbackBias: { "DX": +5, "M&A": -3 },
    };
    const sDx = scoreInitiative(fakeCtx, {
      id: 1, category: "DX", industry_tags: [], target_themes: [],
    });
    const sMa = scoreInitiative(fakeCtx, {
      id: 2, category: "M&A", industry_tags: [], target_themes: [],
    });
    const sZero = scoreInitiative(fakeCtx, {
      id: 3, category: "海外展開", industry_tags: [], target_themes: [],
    });
    check(sDx.score === 5, "scoreInitiative DX with bias +5", "actual=" + sDx.score);
    check(sMa.score === -3, "scoreInitiative M&A with bias -3", "actual=" + sMa.score);
    check(sZero.score === 0, "scoreInitiative no-bias category === 0", "actual=" + sZero.score);

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
