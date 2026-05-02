// 会社名の表記ゆれを吸収する正規化と URL からのドメイン抽出
//
// normalizeCompanyName("株式会社オフィス源泉") === "オフィス源泉"
// normalizeCompanyName("(株)オフィス源泉") === "オフィス源泉"
// normalizeCompanyName("オフィス　源泉") === "オフィス源泉"

const COMPANY_PREFIXES_SUFFIXES = [
  "株式会社",
  "（株）",
  "(株)",
  "㈱",
  "有限会社",
  "（有）",
  "(有)",
  "㈲",
  "合同会社",
  "（同）",
  "(同)",
  "合資会社",
  "合名会社",
  "一般社団法人",
  "公益社団法人",
  "一般財団法人",
  "公益財団法人",
  "社会福祉法人",
  "学校法人",
  "医療法人",
  "宗教法人",
  "特定非営利活動法人",
  "ＮＰＯ法人",
  "NPO法人",
];

/**
 * 会社名を比較しやすい形に正規化する。
 *  - 「株式会社」「(株)」等の組織形態語をすべて除去
 *  - 全角/半角スペース除去
 *  - 全角英数記号 → 半角
 *  - 大文字 → 小文字
 *  - 中点・記号類を除去
 */
function normalizeCompanyName(name) {
  if (!name) return "";

  let s = String(name);

  // 全角英数記号 → 半角
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );

  // 組織形態語を全部除去（複数回出ても良いように繰り返し）
  for (const w of COMPANY_PREFIXES_SUFFIXES) {
    s = s.split(w).join("");
  }

  // スペース類（全角/半角）と中点・記号を削除
  s = s.replace(/[\s　・･,，.。\-‐－—_'`"“”'’]/g, "");

  return s.toLowerCase();
}

/**
 * URL からホスト部（ドメイン）を取り出す。
 * 失敗時は null。
 *   "https://www.example.co.jp/about" → "example.co.jp"
 */
function extractDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch (_e) {
    return null;
  }
}

module.exports = { normalizeCompanyName, extractDomain };
