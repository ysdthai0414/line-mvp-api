// レコメンドロジック (Phase 3 / Phase 6)
// ユーザーの sales_tier より上のフェーズの Initiatives から、
// 業界 / 経営テーマ / 明示された関心 / 嫌ったカテゴリ を勘案してスコア付け、
// 過去配信済みを除いて上位N件を返す。
//
// Phase 6 (2026-05-03): 過去 helpful/not_helpful フィードバックの category 単位
//   集計をバイアスとして加味する。
const {
  getPool,
  getUserPreferences,
  getCategoryFeedbackBias,
  getCollaborativeScores,
} = require("./db");

// 売上フェーズの順位（数字が大きいほど100億に近い）
const TIER_RANK = {
  UNDER_10: 1,
  "10_30": 2,
  "30_50": 3,
  "50_100": 4,
  OVER_100: 5,
};

// 売上(円) → tier ラベルを SQL で計算する CASE 句
const TIER_CASE_SQL = `
  CASE
    WHEN ac.annual_sales IS NULL THEN NULL
    WHEN ac.annual_sales < 1000000000 THEN 'UNDER_10'
    WHEN ac.annual_sales < 3000000000 THEN '10_30'
    WHEN ac.annual_sales < 5000000000 THEN '30_50'
    WHEN ac.annual_sales < 10000000000 THEN '50_100'
    ELSE 'OVER_100'
  END
`;

const SCORE_WEIGHT = {
  industry: 2,
  theme: 3,
  interest: 4, // 明示された関心は最重要視
  disliked: -3, // 嫌ったカテゴリはペナルティ
  feedback_category: 1, // Phase 6: 過去 helpful/not_helpful の累計を category 単位で加算
  collab: 1.5, // D2: 類似ユーザー集団の helpful 件数（暗黙シグナル、明示より弱め）
};

// D2: 協調スコアの上限（1件の人気事例で過剰加点を防ぐ）
const COLLAB_SCORE_CAP = 5;

/**
 * 確定済みプロファイルとユーザー情報を取得。
 * Phase 6 で feedbackBias (category 単位の過去フィードバック累計) も併せて取得。
 */
async function getUserContext(lineUserId) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT u.line_user_id, u.sales_tier, u.annual_sales, u.approved_company_id, " +
    "       p.profile_json " +
    "FROM Users u " +
    "LEFT JOIN Profiles p ON p.line_user_id = u.line_user_id " +
    "WHERE u.line_user_id = ? AND u.state = 'CONFIRMED' " +
    "ORDER BY p.created_at DESC LIMIT 1",
    [lineUserId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const profile =
    typeof r.profile_json === "string"
      ? JSON.parse(r.profile_json)
      : r.profile_json || {};
  const prefs = await getUserPreferences(lineUserId);
  const feedbackBias = await getCategoryFeedbackBias(lineUserId);
  const collabScores = await getCollaborativeScores(lineUserId);
  return {
    lineUserId: r.line_user_id,
    salesTier: r.sales_tier,
    annualSales: r.annual_sales,
    approvedCompanyId: r.approved_company_id,
    profile,
    interests: prefs.interests,
    dislikedCategories: prefs.dislikedCategories,
    feedbackBias, // { "DX": +2, "M&A": -1, ... }
    collabScores, // D2: { initiative_id: count, ... }
  };
}

/**
 * 配信候補となる Initiative を取得。
 * - status='published'
 * - 過去配信済みのものは除外
 * - 自社の事例も除外
 */
async function getCandidateInitiatives(userCtx) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT i.id, i.approved_company_id, i.title, i.summary, i.detail_url, " +
    "       i.category, i.industry_tags, i.target_themes, i.bullet_points, " +
    "       i.cover_image_url, " +
    "       ac.company_name, ac.annual_sales, " +
    `       ${TIER_CASE_SQL} AS company_sales_tier ` +
    "FROM Initiatives i " +
    "JOIN ApprovedCompanies ac ON ac.id = i.approved_company_id " +
    "WHERE i.status = 'published' " +
    "  AND (i.approved_company_id <> ? OR ? IS NULL) " +
    "  AND i.id NOT IN (" +
    "    SELECT initiative_id FROM DeliveryLog WHERE line_user_id = ?" +
    "  )",
    [
      userCtx.approvedCompanyId || 0,
      userCtx.approvedCompanyId,
      userCtx.lineUserId,
    ]
  );
  return rows.map((r) => ({
    ...r,
    industry_tags: r.industry_tags || [],
    target_themes: r.target_themes || [],
    bullet_points: r.bullet_points || [],
  }));
}

/**
 * Initiative を1件スコアリング。
 * 戻り値: { score, reasons: { industries: [], themes: [], interests: [],
 *                              penalty: bool, feedbackBias: number } }
 */
function scoreInitiative(userCtx, init) {
  const profile = userCtx.profile || {};
  const userIndustry = (profile.industry_tags || []).map(toKey);
  const userTheme = [
    ...(profile.management_themes || []),
    ...(profile.wanted_support_areas || []),
  ].map(toKey);
  const userInterests = (userCtx.interests || []).map(toKey);
  const dislikedSet = new Set((userCtx.dislikedCategories || []).map(toKey));

  const initIndustry = (init.industry_tags || []).map(toKey);
  const initTheme = (init.target_themes || []).map(toKey);
  const initCategoryKey = toKey(init.category);

  // 重複した実際のラベルを返したいので、原文のラベルからのintersect結果を出す
  const matchedIndustries = (init.industry_tags || []).filter((t) =>
    userIndustry.includes(toKey(t))
  );
  const matchedThemes = (init.target_themes || []).filter((t) =>
    userTheme.includes(toKey(t))
  );
  const matchedInterests = (userCtx.interests || []).filter(
    (i) => toKey(i) === initCategoryKey || initTheme.includes(toKey(i))
  );

  const penalty = dislikedSet.has(initCategoryKey);

  // Phase 6: フィードバックバイアス（category単位）
  const feedbackBiasRaw =
    (userCtx.feedbackBias && init.category &&
      userCtx.feedbackBias[init.category]) || 0;

  // D2: 協調スコア（類似ユーザー集団が helpful にした件数、上限あり）
  const collabRaw =
    (userCtx.collabScores && userCtx.collabScores[init.id]) || 0;
  const collabCapped = Math.min(collabRaw, COLLAB_SCORE_CAP);

  const score =
    matchedIndustries.length * SCORE_WEIGHT.industry +
    matchedThemes.length * SCORE_WEIGHT.theme +
    matchedInterests.length * SCORE_WEIGHT.interest +
    (penalty ? SCORE_WEIGHT.disliked : 0) +
    feedbackBiasRaw * SCORE_WEIGHT.feedback_category +
    collabCapped * SCORE_WEIGHT.collab;

  return {
    score,
    reasons: {
      industries: matchedIndustries,
      themes: matchedThemes,
      interests: matchedInterests,
      category: init.category || null,
      penalty,
      feedbackBias: feedbackBiasRaw, // 0 なら影響なし、+/- でフィードバック反映済み
      collab: collabRaw, // D2: 類似ユーザー何人が helpful にしたか（上限なしの生値）
      collabCapped, // 実際にスコアに使われた値
    },
  };
}

function toKey(s) {
  return String(s || "").trim().toLowerCase();
}

/**
 * フェーズフィルタ：候補企業の sales_tier が user より厳密に「上」かを判定。
 * 「次フェーズの参考」哲学を維持。
 */
function isHigherPhase(userCtx, initiative) {
  if (!userCtx.salesTier) return true;
  const userRank = TIER_RANK[userCtx.salesTier] || 0;
  const initRank = TIER_RANK[initiative.company_sales_tier] || 0;
  return initRank > userRank;
}

/**
 * 同 tier も含めて「同じ or 上」かを判定。
 * recommendForUser のフォールバック用：上の tier が空の場合のみ使う。
 */
function isSameOrHigherPhase(userCtx, initiative) {
  if (!userCtx.salesTier) return true;
  const userRank = TIER_RANK[userCtx.salesTier] || 0;
  const initRank = TIER_RANK[initiative.company_sales_tier] || 0;
  return initRank >= userRank;
}

/**
 * 公開API: あるユーザーへのおすすめ Initiative を最大 limit 件返す。
 * 戻り値: Initiative[] （score 降順、各要素に _score / _reasons を持つ）
 */
async function recommendForUser(lineUserId, limit = 3) {
  const userCtx = await getUserContext(lineUserId);
  if (!userCtx) return [];

  const candidates = await getCandidateInitiatives(userCtx);

  // 第一候補：「次フェーズ」哲学を守って厳密に上の tier だけ
  let pool = candidates.filter((c) => isHigherPhase(userCtx, c));

  // フォールバック：上の tier が空（user がトップ層 or プール薄い時）のみ、
  // 同 tier も含めて配信を確保。下位 tier には混ぜない。
  if (pool.length === 0) {
    pool = candidates.filter((c) => isSameOrHigherPhase(userCtx, c));
  }

  const scored = pool
    .map((c) => {
      const s = scoreInitiative(userCtx, c);
      return { ...c, _score: s.score, _reasons: s.reasons };
    })
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return b.id - a.id;
    });

  return scored.slice(0, limit);
}

module.exports = {
  recommendForUser,
  getUserContext,
  getCandidateInitiatives,
  scoreInitiative,
  isHigherPhase,
  isSameOrHigherPhase,
  TIER_RANK,
  SCORE_WEIGHT,
  COLLAB_SCORE_CAP,
};
