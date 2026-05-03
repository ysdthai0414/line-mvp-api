// Claude API を使って会社プロファイルを生成（マッチング・配信前提）
const { Anthropic } = require("@anthropic-ai/sdk");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

/**
 * 会社名・URL・サイト本文・売上情報から、構造化されたプロファイルを生成する。
 * 戻り値:
 *   {
 *     business_summary: string,         // 事業内容の要約 (2-3文)
 *     target_customers: string,         // 主な顧客像 (1-2文)
 *     industry_tags: string[],          // 業界・領域タグ (3-5個)
 *     management_themes: string[],      // 経営テーマ (人/販路/資金/プロダクト/組織 等から3個)
 *     wanted_support_areas: string[],   // 自分より進んだ企業から学びたい領域 (2-3個)
 *     strengths: string[]               // 強み (3個)
 *   }
 */
async function generateCompanyProfile({
  companyName,
  companyUrl,
  siteText,
  annualSales,
  salesTier,
}) {
  const sitePart = siteText
    ? "■ 会社サイトから取得した本文（抜粋）:\n" + siteText
    : "■ 会社サイトの本文取得に失敗しました。会社名と URL のみを根拠に推測してください。";

  const salesLine =
    annualSales != null
      ? "■ 直近売上高: 約" +
        (annualSales / 100000000).toFixed(1) +
        "億円 (フェーズ: " + (salesTier || "未分類") + ")"
      : "■ 直近売上高: データなし";

  const userMessage =
    "あなたは「100億宣言支援AI」の中の人として、すでに『100億宣言』の認可を受けている企業の経営者にヒアリングする前段階の下調べを行っています。\n" +
    "このAIサービスの目的は、ユーザー企業よりも経営フェーズ（売上規模）が進んだ他の認可企業の取り組みを月1回ほど配信し、必要に応じて『この会社の話を聞きたい』というマッチング依頼を受けることです。\n" +
    "そのため、生成するプロファイルは『どんな業界・どんな経営テーマの事例を配信すれば刺さるか』『マッチング先候補をどう選ぶか』の判断材料になることを意識してください。\n\n" +
    "■ 会社名: " + companyName + "\n" +
    "■ 会社サイトURL: " + companyUrl + "\n" +
    salesLine + "\n" +
    sitePart + "\n\n" +
    "# 出力フォーマット（必ず純粋なJSONのみを返す。前後に説明文や ``` を付けない）\n" +
    "{\n" +
    "  \"business_summary\": \"事業内容の要約（2〜3文・全角200文字以内）\",\n" +
    "  \"target_customers\": \"主な顧客像（1〜2文・全角120文字以内）\",\n" +
    "  \"industry_tags\": [\"業界・領域タグ1（10文字以内）\", \"...\"],\n" +
    "  \"management_themes\": [\"経営テーマ1（例: 採用強化 / 海外販路 / DX / 事業承継 / 資金調達）\", \"...\"],\n" +
    "  \"wanted_support_areas\": [\"より進んだ企業から学びたいと推測される領域1（30文字以内）\", \"...\"],\n" +
    "  \"strengths\": [\"強み1（30文字以内）\", \"強み2\", \"強み3\"],\n" +
    "  \"representative_name\": \"代表取締役の氏名（例：吉田 航平）。会社サイトの『会社概要』『役員一覧』『代表メッセージ』等から抽出。見つからなければ null\"\n" +
    "}\n\n" +
    "# ルール\n" +
    "- industry_tags は 3〜5個、management_themes は 3個、wanted_support_areas は 2〜3個\n" +
    "- 不確実な情報は断定せず「〜と推測されます」のような表現を使う\n" +
    "- 公開情報から確認できないことは無理に作らず、汎用的な表現で構わない\n" +
    "- 経営者本人が「ああ、それね」とすぐ納得できる粒度で書く\n" +
    "- representative_name は必ずフィールドを出すが、確実に取れない場合は null を入れる（推測しない）。役職を含めず氏名のみ（例：「代表取締役 吉田 航平」ではなく「吉田 航平」）";

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = (resp.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      "AIレスポンスのJSONパースに失敗: " + e.message + "\nraw: " + text.slice(0, 500)
    );
  }

  const required = [
    "business_summary",
    "target_customers",
    "industry_tags",
    "management_themes",
    "wanted_support_areas",
    "strengths",
  ];
  for (const k of required) {
    if (!(k in parsed)) {
      throw new Error("AIレスポンスに必須キー " + k + " が無い: " + cleaned);
    }
  }
  return parsed;
}

module.exports = {
  generateCompanyProfile,
};
