// Claude で配信時の「あなたへ」推薦理由を動的生成 (D1)
//
// 既存の flex.buildReasonText は静的テンプレだったが、
// ユーザーの profile / interests / 過去 feedbackBias / マッチした industry/theme
// を Claude に渡して、より具体的で説得力のある一文を生成する。
//
// コスト目安: 1呼び出しあたり入力 ~400 token、出力 ~80 token = 約 $0.001
// 100ユーザー × 3件 = $0.30/月 程度に収まる
//
// 設計判断:
//   - REASON_AI_DISABLED=true で動的生成を停止 → 呼び出し側はフォールバック使用
//   - mockAi=true でClaude呼ばずダミー文を返す（テスト用、コスト0）
//   - 失敗時は throw ではなく null を返す（呼び出し側で静的テンプレにフォールバック）
//   - 生成テキストは最大120字に切り詰め（Flex 表示崩れ防止）

const { Anthropic } = require("@anthropic-ai/sdk");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const MAX_OUTPUT_LENGTH = 120;

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function isDisabled() {
  return (process.env.REASON_AI_DISABLED || "").toLowerCase() === "true";
}

const MOCK_REASON =
  "（モック）御社の業界・経営テーマに近い事例として選びました。";

/**
 * 推薦理由を動的生成する。
 *   args = {
 *     user: {
 *       companyName?, salesTier?, profile? { industry_tags, management_themes, ... },
 *       interests?: [...]
 *     },
 *     initiative: {
 *       title, summary?, category, industry_tags?, target_themes?, bullet_points?,
 *       company_name?
 *     },
 *     reasons: {  // recommend.js scoreInitiative の戻り値
 *       industries: [...], themes: [...], interests: [...],
 *       category, penalty, feedbackBias
 *     },
 *     mockAi?: bool
 *   }
 *
 * 戻り値: 推薦理由テキスト (string) または null（生成失敗 or 無効化）
 */
async function generateReasonText(args) {
  if (isDisabled()) return null;

  const { user, initiative, reasons, mockAi } = args || {};
  if (!user || !initiative) return null;

  if (mockAi) {
    return MOCK_REASON;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    // APIキー未設定なら諦めて静的にフォールバック
    return null;
  }

  const profile = (user && user.profile) || {};
  const userCompany = user.companyName || "御社";
  const userTier = user.salesTier || "—";
  const userIndustryTags = (profile.industry_tags || []).slice(0, 5).join("、") || "—";
  const userThemes = [
    ...(profile.management_themes || []),
    ...(profile.wanted_support_areas || []),
  ].slice(0, 5).join("、") || "—";
  const userInterests = (user.interests || []).slice(0, 5).join("、") || "（未設定）";

  const initIndustryTags = (initiative.industry_tags || []).slice(0, 4).join("、") || "—";
  const initThemes = (initiative.target_themes || []).slice(0, 3).join("、") || "—";
  const matchedIndustries = (reasons && reasons.industries || []).join("、") || "—";
  const matchedThemes = (reasons && reasons.themes || []).join("、") || "—";
  const matchedInterests = (reasons && reasons.interests || []).join("、") || "—";
  const feedbackBias = reasons && typeof reasons.feedbackBias === "number" ? reasons.feedbackBias : 0;

  const userMessage =
    "あなたは「100億宣言支援AI」の配信担当として、ユーザー企業の経営者に対して、" +
    "個別の取り組み事例の推薦理由を1〜2文で短く伝える役割です。\n\n" +
    "■ ユーザー企業:\n" +
    "  - 会社名: " + userCompany + "\n" +
    "  - 売上フェーズ: " + userTier + "\n" +
    "  - 業界タグ: " + userIndustryTags + "\n" +
    "  - 経営テーマ: " + userThemes + "\n" +
    "  - 明示の関心テーマ: " + userInterests + "\n\n" +
    "■ 推薦する事例:\n" +
    "  - タイトル: " + (initiative.title || "—") + "\n" +
    "  - 主催企業: " + (initiative.company_name || "—") + "\n" +
    "  - カテゴリ: " + (initiative.category || "—") + "\n" +
    "  - 業界タグ: " + initIndustryTags + "\n" +
    "  - 対象テーマ: " + initThemes + "\n" +
    (initiative.summary ? "  - 要約: " + String(initiative.summary).slice(0, 200) + "\n" : "") +
    "\n" +
    "■ マッチ理由（スコア計算結果）:\n" +
    "  - 一致した業界タグ: " + matchedIndustries + "\n" +
    "  - 一致した経営テーマ: " + matchedThemes + "\n" +
    "  - 明示関心の一致: " + matchedInterests + "\n" +
    "  - 過去フィードバック傾向（このカテゴリ）: " + (feedbackBias > 0 ? "ポジティブ +" + feedbackBias : feedbackBias < 0 ? "ネガティブ " + feedbackBias : "中立0") + "\n\n" +
    "# 出力ルール\n" +
    "- 1〜2文、合計60〜120文字程度\n" +
    "- 「御社」または会社名で呼びかける敬体\n" +
    "- 一致した具体要素（業界タグ・経営テーマ・関心）を1〜2つ取り上げて言及する\n" +
    "- 過去フィードバックがポジティブなら「これまで反応良かった〜系の続き」のニュアンス、ネガティブなら言及しない（無理に取り上げない）\n" +
    "- 押し付けがましくならないトーン（「〜のヒントになるかもしれません」「〜に近い切り口です」など）\n" +
    "- 装飾記号や絵文字は最小限。基本テキストのみ\n" +
    "- 必ず純粋なテキスト1行のみで出力。前後の説明文や鍵カッコは不要";

  try {
    const resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: "user", content: userMessage }],
    });
    const raw = (resp.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!raw) return null;
    // 1行目のみ採用、長すぎたら切る
    const firstLine = raw.split(/\r?\n/)[0].trim();
    return firstLine.slice(0, MAX_OUTPUT_LENGTH);
  } catch (err) {
    console.warn("[reason_ai] generateReasonText failed:", err && err.message);
    return null;
  }
}

module.exports = {
  generateReasonText,
  MOCK_REASON,
  MAX_OUTPUT_LENGTH,
};
