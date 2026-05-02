// 会社サイトをfetchして本文テキストを抽出する
// Node 18+ の fetch を利用（追加ライブラリ不要）
const cheerio = require("cheerio");

const FETCH_TIMEOUT_MS = 10000;
const MAX_TEXT_LENGTH = 8000; // Claude に渡す上限（プロンプトを膨らませすぎないため）

/**
 * URL から本文テキストとメタ情報を取り出す。
 * 失敗時は { ok:false, reason } を返す（throwしない）。
 */
async function fetchSiteText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // 一般的なブラウザを装う（最低限のUA）
        "User-Agent":
          "Mozilla/5.0 (compatible; OfficeGensenBot/1.0; +https://office-gensen.jp)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
      return { ok: false, reason: `Unexpected content-type: ${ct}` };
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // ノイズ要素を除去
    $("script, style, noscript, iframe, svg").remove();

    const title = ($("title").first().text() || "").trim();
    const description =
      ($('meta[name="description"]').attr("content") ||
        $('meta[property="og:description"]').attr("content") ||
        "").trim();

    // <main> があれば優先、なければ <body>
    const root = $("main").length ? $("main") : $("body");
    let bodyText = root.text() || "";
    bodyText = bodyText.replace(/\s+/g, " ").trim();

    if (bodyText.length > MAX_TEXT_LENGTH) {
      bodyText = bodyText.slice(0, MAX_TEXT_LENGTH);
    }

    return {
      ok: true,
      title,
      description,
      bodyText,
    };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchSiteText };
