// Claude API で「100億宣言PDF」から取り組み事例の構造化データを抽出する
//
// 入力:
//   companyName, salesTier, prefecture (任意), pdfText
// 出力（純粋なJSON）:
//   {
//     title: string,                  // 配信タイトル（30字目安）
//     summary: string,                // 配信要約（〜500字）
//     bullet_points: string[],        // 要点 3〜5件
//     category: enum,                 // categories.js の CATEGORIES のいずれか
//     industry_tags: string[],        // 業界タグ 2〜4件
//     target_themes: string[]         // 経営テーマ 1〜3件（categoriesと近い語彙）
//   }
const { Anthropic } = require("@anthropic-ai/sdk");
const { CATEGORIES, isValidCategory } = require("./categories");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

// --mock-ai 用のダミー出力（API呼ばずに動作確認）
const MOCK_INITIATIVE = {
  title: "（モック）販路拡大と人材確保で売上倍増を狙う",
  summary:
    "（モック生成）地方の卸売業として、既存の地場顧客に依存せず、関東圏の中堅小売との直販ルートを拡大。" +
    "並行して新卒採用と中堅マネジャー層の育成に投資し、3年で売上倍増を目指す。",
  bullet_points: [
    "関東圏の中堅小売との直販チャネル開拓",
    "新卒採用の母集団形成と内定承諾率改善",
    "中堅マネジャー層の育成プログラム導入",
  ],
  category: "販路拡大",
  industry_tags: ["卸売業", "建設業"],
  target_themes: ["販路拡大", "人材確保・育成"],
};

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/**
 * Claude を呼んで Initiative データを構造化する。
 * mockAi=true のときは API を呼ばずダミーを返す（コスト0）。
 */
async function generateInitiative({
  companyName,
  salesTier,
  prefecture,
  pdfText,
  mockAi = false,
}) {
  if (mockAi) {
    return JSON.parse(JSON.stringify(MOCK_INITIATIVE));
  }

  if (!pdfText) {
    throw new Error("generateInitiative: pdfText is required");
  }

  const categoriesLine = CATEGORIES.join(" / ");

  const userMessage =
    "あなたは「100億宣言支援AI」の編集担当として、認可済企業の宣言PDFから、" +
    "他の経営者にとって参考になりそうな取り組み事例を1件、抽出して構造化します。\n" +
    "出力は配信用のショートカードに掲載する想定です。\n\n" +
    "■ 会社名: " + companyName + "\n" +
    "■ 売上フェーズ: " + (salesTier || "未分類") + "\n" +
    (prefecture ? "■ 本社所在地: " + prefecture + "\n" : "") +
    "\n" +
    "■ 宣言PDFから抽出した本文（抜粋）:\n" +
    pdfText +
    "\n\n" +
    "# 出力フォーマット（必ず純粋なJSONのみを返す。前後に説明文や ``` を付けない）\n" +
    "{\n" +
    "  \"title\": \"配信タイトル（30字以内、固有名詞を含めても可）\",\n" +
    "  \"summary\": \"配信用の要約（200〜500字、敬体で）\",\n" +
    "  \"bullet_points\": [\"要点1（30字以内）\", \"要点2\", \"要点3\"],\n" +
    "  \"category\": \"" + CATEGORIES[0] + " / " + CATEGORIES[1] + " のように、必ず以下のいずれか1つ\",\n" +
    "  \"industry_tags\": [\"業界タグ1\", \"業界タグ2\"],\n" +
    "  \"target_themes\": [\"経営テーマ1\", \"経営テーマ2\"]\n" +
    "}\n\n" +
    "# ルール\n" +
    "- category は次のリストから必ず1つ選ぶ: " + categoriesLine + "\n" +
    "- bullet_points は 3〜5件\n" +
    "- industry_tags は 2〜4件、target_themes は 1〜3件\n" +
    "- 公開情報から確認できないことは無理に作らない（自信のない数字や固有名詞は出さない）\n" +
    "- 経営者が読んで「ああ、それね」と納得できる粒度で書く\n" +
    "- 同業他社の参考になることを優先（自社固有のPRは抑える）";

  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = (resp.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      "AIレスポンスのJSONパース失敗: " + e.message + " / raw: " + raw.slice(0, 500)
    );
  }

  return normalizeInitiative(parsed);
}

/**
 * AI出力を検証＆正規化する。category は CATEGORIES に必ず収める。
 * 想定外の category が来た場合は近いものへフォールバック（後段で人間がレビュー）。
 */
function normalizeInitiative(p) {
  if (!p || typeof p !== "object") {
    throw new Error("AI出力が object ではない");
  }
  const required = [
    "title",
    "summary",
    "bullet_points",
    "category",
    "industry_tags",
    "target_themes",
  ];
  for (const k of required) {
    if (!(k in p)) {
      throw new Error("AI出力に必須キー欠落: " + k);
    }
  }

  // 配列の正規化
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);
  const out = {
    title: String(p.title || "").trim().slice(0, 60),
    summary: String(p.summary || "").trim().slice(0, 500),
    bullet_points: arr(p.bullet_points).slice(0, 5),
    category: String(p.category || "").trim(),
    industry_tags: arr(p.industry_tags).slice(0, 4),
    target_themes: arr(p.target_themes).slice(0, 3),
  };

  if (!isValidCategory(out.category)) {
    // 想定外カテゴリは「販路拡大」にひとまず寄せる（事務局レビューで直す前提）
    console.warn(
      "[initiative_ai] unknown category from AI: '" + out.category +
        "' → fallback to '販路拡大' (review needed)"
    );
    out.category = "販路拡大";
  }

  return out;
}

module.exports = {
  generateInitiative,
  normalizeInitiative,
  MOCK_INITIATIVE,
};
