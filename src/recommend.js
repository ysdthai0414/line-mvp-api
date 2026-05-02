// レコメンドロジック (Phase 3)
// ユーザーの sales_tier より上のフェーズの Initiatives から、
// 業界 / 経営テーマ / 明示された関心 / 嫌ったカテゴリ を勘案してスコア付け、
// 過去配信済みを除いて上位N件を返す。
const { getPool, getUserPreferences } = require("./db");

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
};

/**
 * 確定済みプロファイルとユーザー情報を取得。
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
  return {
    lineUserId: r.line_user_id,
    salesTier: r.sales_tier,
    annualSales: r.annual_sales,
    approvedCompanyId: r.approved_company_id,
    profile,
    interests: prefs.interests,
    dislikedCategories: prefs.dislikedCategories,
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
 * 戻り値: { score, reasons: { industries: [], themes: [], interests: [], penalty: bool } }
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

  const score =
    matchedIndustries.length * SCORE_WEIGHT.industry +
    matchedThemes.length * SCORE_WEIGHT.theme +
    matchedInterests.length * SCORE_WEIGHT.interest +
    (penalty ? SCORE_WEIGHT.disliked : 0);

  return {
    score,
    reasons: {
      industries: matchedIndustries,
      themes: matchedThemes,
      interests: matchedInterests,
      category: init.category || null,
      penalty,
    },
  };
}

function toKey(s) {
  return String(s || "").trim().toLowerCase();
}

/**
 * フェーズフィルタ：候補企業の sales_tier が user より「上」かを判定。
 */
function isHigherPhase(userCtx, initiative) {
  if (!userCtx.salesTier) return true;
  const userRank = TIER_RANK[userCtx.salesTier] || 0;
  const initRank = TIER_RANK[initiative.company_sales_tier] || 0;
  return initRank > userRank;
}

/**
 * 公開API: あるユーザーへのおすすめ Initiative を最大 limit 件返す。
 * 戻り値: Initiative[] （score 降順、各要素に _score / _reasons を持つ）
 */
async function recommendForUser(lineUserId, limit = 3) {
  const userCtx = await getUserContext(lineUserId);
  if (!userCtx) return [];

  const candidates = await getCandidateInitiatives(userCtx);

  const scored = candidates
    .filter((c) => isHigherPhase(userCtx, c))
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
  TIER_RANK,
  SCORE_WEIGHT,
};
