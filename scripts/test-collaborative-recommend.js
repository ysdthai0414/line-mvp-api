#!/usr/bin/env node
// =============================================================
// D2 協調フィルタリング 結合テスト
//
// 使い方:
//   node scripts/test-collaborative-recommend.js
//
// シナリオ:
//   1) クリーンアップ
//   2) テストユーザー A, B, C, D を作成（profileなし、業界マッチ最小化）
//   3) テスト用 Initiatives を作成: I1, I2, I3, I4, I5
//   4) 仕込み:
//      A: helpful → I1, I2
//      B: helpful → I1, I3        （A と I1 で重複 → 類似）
//      C: helpful → I2, I4        （A と I2 で重複 → 類似）
//      D: helpful → I5            （A と重複なし → 非類似）
//   5) getCollaborativeScores(A) を呼び {I3:1, I4:1} を期待（I1, I2は自分済、I5は非類似）
//   6) scoreInitiative で collab スコアが正しく加算される
//   7) COLLAB_SCORE_CAP（5）を超える場合は capped される検証
//   8) クリーンアップ
//
// LINE API は呼ばない、DB のみ。
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const {
  getPool,
  getCollaborativeScores,
} = require("../src/db");
const { scoreInitiative, SCORE_WEIGHT, COLLAB_SCORE_CAP } = require("../src/recommend");

const TEST_USER_PREFIX = "U_TEST_COLLAB_";
const TEST_INIT_TAG = "[TEST_COLLAB]";

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function cleanup() {
  const pool = getPool();
  await pool.execute(
    "DELETE FROM DeliveryLog WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  await pool.execute(
    "DELETE FROM Profiles WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  await pool.execute(
    "DELETE FROM MatchingRequests WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  await pool.execute(
    "DELETE FROM Users WHERE line_user_id LIKE ?",
    [TEST_USER_PREFIX + "%"]
  );
  await pool.execute(
    "DELETE FROM Initiatives WHERE title LIKE ?",
    ["%" + TEST_INIT_TAG + "%"]
  );
}

async function pickAnyApprovedCompany() {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id FROM ApprovedCompanies ORDER BY id LIMIT 1"
  );
  return rows[0];
}

async function setupUsers() {
  const pool = getPool();
  const company = await pickAnyApprovedCompany();
  if (!company) throw new Error("ApprovedCompanies が空です");
  const users = ["A", "B", "C", "D"].map((s) => TEST_USER_PREFIX + s);
  for (const u of users) {
    await pool.execute(
      "INSERT INTO Users " +
      "(line_user_id, state, approved_company_id, sales_tier, annual_sales) " +
      "VALUES (?, 'CONFIRMED', ?, '10_30', 1500000000)",
      [u, company.id]
    );
  }
  return users;
}

async function createInitiative(hostId, suffix) {
  const pool = getPool();
  const [r] = await pool.execute(
    "INSERT INTO Initiatives " +
    "(approved_company_id, title, summary, category, " +
    " industry_tags, target_themes, bullet_points, status, source) " +
    "VALUES (?, ?, ?, '販路拡大', " +
    "        CAST('[]' AS JSON), CAST('[]' AS JSON), CAST('[]' AS JSON), " +
    "        'published', 'test')",
    [hostId, TEST_INIT_TAG + " #" + suffix, "test"]
  );
  return r.insertId;
}

async function recordHelpful(userId, initiativeId) {
  const pool = getPool();
  await pool.execute(
    "INSERT INTO DeliveryLog (line_user_id, initiative_id, feedback) " +
    "VALUES (?, ?, 'helpful')",
    [userId, initiativeId]
  );
}

async function main() {
  console.log("=== D2 協調フィルタリング 結合テスト ===");
  try {
    console.log("\n[STEP 0] cleanup");
    await cleanup();
    pass("pre-cleanup done");

    console.log("\n[STEP 1] テストユーザー4名 + Initiative 5件 作成");
    const [A, B, C, D] = await setupUsers();
    const company = await pickAnyApprovedCompany();
    const I1 = await createInitiative(company.id, 1);
    const I2 = await createInitiative(company.id, 2);
    const I3 = await createInitiative(company.id, 3);
    const I4 = await createInitiative(company.id, 4);
    const I5 = await createInitiative(company.id, 5);
    pass("users + initiatives created");

    console.log("\n[STEP 2] DeliveryLog 仕込み");
    // A: I1, I2
    await recordHelpful(A, I1);
    await recordHelpful(A, I2);
    // B: I1, I3 → A と I1 で重複（類似）
    await recordHelpful(B, I1);
    await recordHelpful(B, I3);
    // C: I2, I4 → A と I2 で重複（類似）
    await recordHelpful(C, I2);
    await recordHelpful(C, I4);
    // D: I5 → A と重複なし（非類似）
    await recordHelpful(D, I5);
    pass("DeliveryLog seeded");

    console.log("\n[STEP 3] getCollaborativeScores(A) の検証");
    const scoresA = await getCollaborativeScores(A);
    console.log("  scoresA:", scoresA);
    check(scoresA[I3] === 1, "I3 score === 1 (B が類似で I3 を helpful)", "actual=" + scoresA[I3]);
    check(scoresA[I4] === 1, "I4 score === 1 (C が類似で I4 を helpful)", "actual=" + scoresA[I4]);
    check(scoresA[I1] === undefined, "I1 は自分既 helpful なので含まれない");
    check(scoresA[I2] === undefined, "I2 は自分既 helpful なので含まれない");
    check(scoresA[I5] === undefined, "I5 は非類似ユーザー D の helpful なので含まれない");

    console.log("\n[STEP 4] minOverlap=2 で類似ユーザーが 0 になる");
    const scoresStrict = await getCollaborativeScores(A, { minOverlap: 2 });
    check(
      Object.keys(scoresStrict).length === 0,
      "minOverlap=2 → 類似ユーザー無し → 空オブジェクト",
      "actual keys=" + Object.keys(scoresStrict).length
    );

    console.log("\n[STEP 5] scoreInitiative で collab スコア反映");
    const userCtx = {
      lineUserId: A,
      salesTier: "10_30",
      profile: {},
      interests: [],
      dislikedCategories: [],
      feedbackBias: {},
      collabScores: scoresA,
    };
    const sI3 = scoreInitiative(userCtx, {
      id: I3, category: "販路拡大", industry_tags: [], target_themes: [],
    });
    check(sI3.score === SCORE_WEIGHT.collab * 1, "I3 score === 1.5", "actual=" + sI3.score);
    check(sI3.reasons.collab === 1, "reasons.collab === 1");
    check(sI3.reasons.collabCapped === 1, "reasons.collabCapped === 1");

    const sNoCollab = scoreInitiative(userCtx, {
      id: 999999, category: "販路拡大", industry_tags: [], target_themes: [],
    });
    check(sNoCollab.score === 0, "未知のIDは collab=0 → score=0");
    check(sNoCollab.reasons.collab === 0, "reasons.collab === 0");

    console.log("\n[STEP 6] COLLAB_SCORE_CAP の上限検証");
    // ctxに無理やり大きな値をセット
    const bigCtx = { ...userCtx, collabScores: { 12345: 99 } };
    const sBig = scoreInitiative(bigCtx, {
      id: 12345, category: "販路拡大", industry_tags: [], target_themes: [],
    });
    check(
      sBig.reasons.collab === 99,
      "reasons.collab === 99 (生値はcapしない)",
      "actual=" + sBig.reasons.collab
    );
    check(
      sBig.reasons.collabCapped === COLLAB_SCORE_CAP,
      "reasons.collabCapped === COLLAB_SCORE_CAP (=5)",
      "actual=" + sBig.reasons.collabCapped
    );
    check(
      sBig.score === COLLAB_SCORE_CAP * SCORE_WEIGHT.collab,
      "score === CAP × weight (5 × 1.5 = 7.5)",
      "actual=" + sBig.score
    );

    console.log("\n[STEP 7] helpful が0件のユーザーは collab スコア空");
    const scoresD = await getCollaborativeScores(D);
    // D は I5 だけ helpful。重複条件で類似ユーザー候補は I5 を helpful した他人だが、
    // ここでは A/B/C は I5 を helpful していない → 類似ユーザー無し
    check(
      Object.keys(scoresD).length === 0,
      "D の collabScores は空（類似ユーザー無し）",
      "actual=" + JSON.stringify(scoresD)
    );

    console.log("\n[STEP 8] helpful 履歴ゼロのユーザーは即時に空");
    const pool = getPool();
    const newUser = TEST_USER_PREFIX + "ZERO";
    await pool.execute(
      "INSERT INTO Users (line_user_id, state, approved_company_id, sales_tier, annual_sales) " +
      "VALUES (?, 'CONFIRMED', ?, '10_30', 1500000000)",
      [newUser, company.id]
    );
    const scoresZero = await getCollaborativeScores(newUser);
    check(
      Object.keys(scoresZero).length === 0,
      "helpful 履歴ゼロ → 空オブジェクト"
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
