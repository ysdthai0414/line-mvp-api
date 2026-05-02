// 100億宣言の取り組みカテゴリ（中小企業庁/中小機構の公式文書で繰り返し使われる用語）
// recommend / flex / handlers から共通参照する。

const CATEGORIES = [
  "人材確保・育成",
  "M&A",
  "海外展開",
  "DX",
  "設備投資・生産体制",
  "新事業・多角化",
  "販路拡大",
  "事業承継",
];

/**
 * Quick Reply 用にカテゴリを LINE のボタン形式に変換。
 * postback data: action=interest&category=XXX
 */
function buildCategoryQuickReply() {
  return {
    items: CATEGORIES.map((cat) => ({
      type: "action",
      action: {
        type: "postback",
        label: cat.length > 20 ? cat.slice(0, 19) + "…" : cat,
        data: "action=interest&category=" + encodeURIComponent(cat),
        displayText: "「" + cat + "」に関心があります",
      },
    })),
  };
}

function isValidCategory(cat) {
  return CATEGORIES.includes(cat);
}

module.exports = {
  CATEGORIES,
  buildCategoryQuickReply,
  isValidCategory,
};
