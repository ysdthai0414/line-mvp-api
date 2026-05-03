// オンボーディング会話ロジック
// 1) 会社名 + URL のパース
// 2) 認可済企業マスタとの照合
// 3) サイト本文取得 + AIプロファイル生成
const { fetchSiteText } = require("./scraper");
const { generateCompanyProfile } = require("./ai");
const { normalizeCompanyName } = require("./match");
const {
  findApprovedCompanies,
  findApprovedCompaniesWithPrefecture,
  classifySalesTier,
} = require("./db");

/**
 * テキストから「会社名 + URL」を抽出する。
 *   "株式会社オフィス源泉\nhttps://office-gensen.jp" → { companyName, companyUrl }
 */
function parseCompanyAndUrl(text) {
  if (!text) return null;
  const urlRegex = /https?:\/\/[^\s　]+/i;
  const m = text.match(urlRegex);
  if (!m) return null;

  const url = m[0].replace(/[、。」)\]]+$/, "");
  const remainder = text.replace(m[0], "").replace(/\s+/g, " ").trim();
  if (!remainder) return null;

  const cleaned = remainder.replace(/^(会社名|社名)[:：]\s*/, "").trim();
  return { companyName: cleaned, companyUrl: url };
}

/**
 * 認可マッチを取る。戻り値:
 *   { matched: true,  candidate, ambiguous: bool }   1件以上HIT (ambiguous=候補>1)
 *   { matched: false }                                認可なし
 */
async function checkApproval(companyName) {
  const normalized = normalizeCompanyName(companyName);
  const candidates = await findApprovedCompanies(normalized);
  if (candidates.length === 0) return { matched: false };
  return {
    matched: true,
    candidate: candidates[0],
    ambiguous: candidates.length > 1,
    allCandidates: candidates,
  };
}

/**
 * 同名衝突 → 都道府県選択 後の再照合。
 * 戻り値:
 *   { matched: true,  candidate, ambiguous, allCandidates }
 *     ambiguous=true は同名かつ同都道府県が2社以上あるレアケース。
 *     呼び出し側で「先頭採用 + 警告ログ」する想定。
 *   { matched: false }
 *     都道府県で絞ったら0件になった（ユーザー入力ミスの可能性）
 */
async function resolveByPrefecture(companyName, prefecture) {
  const normalized = normalizeCompanyName(companyName);
  const candidates = await findApprovedCompaniesWithPrefecture(
    normalized,
    prefecture
  );
  if (candidates.length === 0) return { matched: false };
  return {
    matched: true,
    candidate: candidates[0],
    ambiguous: candidates.length > 1,
    allCandidates: candidates,
  };
}

/**
 * 候補リストから「重複を除いたユニークな都道府県の配列」を返す。
 * NULL は除外、出現順を保つ。
 */
function uniquePrefectures(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates || []) {
    const p = c && c.prefecture;
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * 認可済企業のメタデータと取得サイト本文を Claude に渡してプロファイル生成。
 */
async function buildProfileForApproved({
  companyName,
  companyUrl,
  approvedCompany,
}) {
  const siteResult = await fetchSiteText(companyUrl);
  if (!siteResult.ok) {
    console.warn("[onboarding] site fetch failed:", siteResult.reason);
  }
  const siteText = siteResult.ok
    ? "タイトル: " + siteResult.title +
      "\n概要: " + siteResult.description +
      "\n本文: " + siteResult.bodyText
    : null;

  const annualSales = approvedCompany ? approvedCompany.annual_sales : null;
  const salesTier = classifySalesTier(annualSales);

  const profile = await generateCompanyProfile({
    companyName,
    companyUrl,
    siteText,
    annualSales,
    salesTier,
  });

  return {
    profile,
    annualSales,
    salesTier,
    siteFetched: siteResult.ok,
  };
}

module.exports = {
  parseCompanyAndUrl,
  checkApproval,
  resolveByPrefecture,
  uniquePrefectures,
  buildProfileForApproved,
};
