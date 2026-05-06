// Claude で配信時の「あなたへ」推薦理由 + 応用ポイントを動的生成 (D1 + Phase 7-3)
//
// 既存の flex.buildReasonText は静的テンプレだったが、
// ユーザーの profile / interests / 過去 feedbackBias / マッチした industry/theme
// を Claude に渡して、より具体的で説得力のある文を生成する。
//
// Phase 7-3：推薦理由（短文1文）に加えて「応用ポイント」（御社で応用するなら〜の
// 2〜3文）も同じプロンプトで同時生成し、JSON で受け取る。
//
// コスト目安: 1呼び出しあたり入力 ~500 token、出力 ~200 token = 約 $0.002
// 100ユーザー × 3件 = $0.6/月 程度に収まる
//
// 設計判断:
//   - REASON_AI_DISABLED=true で動的生成を停止 → 呼び出し側はフォールバック使用
//   - mockAi=true でClaude呼ばずダミー文を返す（テスト用、コスト0）
//   - 失敗時は throw ではなく null を返す（呼び出し側で静的テンプレにフォールバック）
//   - 生成テキストは長さ制限あり（Flex 表示崩れ防止）

const { Anthropic } = require("@anthropic-ai/sdk");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const MAX_OUTPUT_LENGTH = 120;
const MAX_APPLICATION_LENGTH = 200;

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

const MOCK_APPLICATION =
  "（モック）御社の場合は、まず小さな実証から始めて段階的に展開する形で応用できそうです。";

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
    return { reason: MOCK_REASON, application: MOCK_APPLICATION };
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

  const userBusinessSummary =
    profile.business_summary && typeof profile.business_summary === "string"
      ? String(profile.business_summary).slice(0, 200)
      : null;

  const userMessage =
    "あなたは「100億宣言支援AI」の配信担当として、ユーザー企業の経営者に対して、" +
    "個別の取り組み事例の (1) 推薦理由 と (2) 御社への応用ポイント を伝える役割です。\n\n" +
    "■ ユーザー企業:\n" +
    "  - 会社名: " + userCompany + "\n" +
    "  - 売上フェーズ: " + userTier + "\n" +
    "  - 業界タグ: " + userIndustryTags + "\n" +
    "  - 経営テーマ: " + userThemes + "\n" +
    "  - 明示の関心テーマ: " + userInterests + "\n" +
    (userBusinessSummary ? "  - 事業概要: " + userBusinessSummary + "\n" : "") +
    "\n" +
    "■ 推薦する事例:\n" +
    "  - タイトル: " + (initiative.title || "—") + "\n" +
    "  - 主催企業: " + (initiative.company_name || "—") + "\n" +
    "  - カテゴリ: " + (initiative.category || "—") + "\n" +
    "  - 業界タグ: " + initIndustryTags + "\n" +
    "  - 対象テーマ: " + initThemes + "\n" +
    (initiative.summary ? "  - 要約: " + String(initiative.summary).slice(0, 300) + "\n" : "") +
    (Array.isArray(initiative.bullet_points) && initiative.bullet_points.length > 0
      ? "  - 要点: " + initiative.bullet_points.slice(0, 4).map((b) => "・" + b).join(" ") + "\n"
      : "") +
    "\n" +
    "■ マッチ理由（スコア計算結果）:\n" +
    "  - 一致した業界タグ: " + matchedIndustries + "\n" +
    "  - 一致した経営テーマ: " + matchedThemes + "\n" +
    "  - 明示関心の一致: " + matchedInterests + "\n" +
    "  - 過去フィードバック傾向（このカテゴリ）: " + (feedbackBias > 0 ? "ポジティブ +" + feedbackBias : feedbackBias < 0 ? "ネガティブ " + feedbackBias : "中立0") + "\n\n" +
    "# 出力フォーマット（必ず純粋なJSONのみ。前後に説明文や ``` は付けない）\n" +
    "{\n" +
    "  \"reason\": \"推薦理由（1〜2文・60〜120字）。なぜ御社向けに選んだか、一致した具体要素1〜2つに触れる\",\n" +
    "  \"application\": \"御社への応用ポイント（2〜3文・100〜200字）。事例の要素を御社の事業/業界/規模/経営テーマに置き換えて、『御社の場合は〜』『〜の文脈で参考になりそうです』など、具体的に応用イメージを示す\"\n" +
    "}\n\n" +
    "# 共通ルール\n" +
    "- 「御社」または会社名で呼びかける敬体\n" +
    "- 押し付けがましくならないトーン（断定しすぎず「〜のヒントになる」「〜に近い切り口」）\n" +
    "- 装飾記号や絵文字は最小限。基本テキストのみ\n" +
    "- 過去フィードバックがネガティブな場合は言及しない（無理に取り上げない）\n" +
    "- 御社の事業概要が分かる場合はそれを踏まえる\n" +
    "- 確実に取れない情報を推測で書かない";

  try {
    const resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: userMessage }],
    });
    const raw = (resp.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!raw) return null;

    // JSON 抜き出し（前後にコードフェンス等が混じる場合に備えて）
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn("[reason_ai] JSON parse failed:", e.message, "raw=", raw.slice(0, 200));
      return null;
    }

    const reason =
      typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, MAX_OUTPUT_LENGTH) : null;
    const application =
      typeof parsed.application === "string"
        ? parsed.application.trim().slice(0, MAX_APPLICATION_LENGTH)
        : null;

    if (!reason && !application) return null;
    return { reason, application };
  } catch (err) {
    console.warn("[reason_ai] generateReasonText failed:", err && err.message);
    return null;
  }
}

module.exports = {
  generateReasonText,
  MOCK_REASON,
  MOCK_APPLICATION,
  MAX_OUTPUT_LENGTH,
  MAX_APPLICATION_LENGTH,
};
