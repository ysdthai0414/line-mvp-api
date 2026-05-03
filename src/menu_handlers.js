// リッチメニュー (#24) ボタン押下時のレスポンス生成
//
// postback action=menu&item=<profile|history|offers|settings> を受け取り、
// ・ユーザー状態に応じてテキスト/Flex/Quick Reply のメッセージ配列を返す
// ・LINE クライアントへの送信は呼び出し元 (handlers.js) が担当
//
// 各 build* 関数の戻り値:
//   { messages: [...] }  ← LINE Messaging API の messages フィールドにそのまま渡せる配列
const {
  getLatestProfile,
  getRecentDeliveries,
  getPendingMatchingForUser,
  getUserPreferences,
  clearUserInterests,
} = require("./db");
const { buildMyProfileFlex } = require("./flex");
const { buildCategoryQuickReply, CATEGORIES } = require("./categories");

const NO_PROFILE_TEXT =
  "まだプロファイル登録が完了していません🙏\n" +
  "御社名と会社サイトのURLを送ってください。\n\n" +
  "例：\n株式会社○○\nhttps://example.co.jp";

const NO_HISTORY_TEXT =
  "まだ配信履歴はありません。\n" +
  "プロファイル登録から最初の事例配信までは少しタイムラグがあります🙏";

const NO_OFFERS_TEXT =
  "現在、申請中の「話を聞きたい」はありません。\n" +
  "今後の配信で気になる企業があれば「話を聞きたい」を押してください🙏";

const SETTINGS_INTRO_TEXT =
  "現在の関心テーマです。追加・変更したい場合は下のボタンから選び直してください👇";

const SETTINGS_NO_INTERESTS_TEXT =
  "まだ関心テーマは設定されていません。\n" +
  "下のボタンから選んでもらえると、配信される事例の精度が上がります👇";

const SETTINGS_RESET_DONE_TEXT =
  "関心テーマをリセットしました。\n" +
  "下のボタンから改めて選び直してください👇";

// 文字列をテキストメッセージに包む
function txt(text, quickReply) {
  const msg = { type: "text", text };
  if (quickReply) msg.quickReply = quickReply;
  return msg;
}

/** 「マイプロファイル」 → 最新Profileを Flex で */
async function buildProfileMessage(lineUserId) {
  const latest = await getLatestProfile(lineUserId);
  if (!latest) {
    return { messages: [txt(NO_PROFILE_TEXT)] };
  }
  const flex = buildMyProfileFlex({
    companyName: latest.companyName,
    companyUrl: latest.companyUrl,
    salesTier: latest.salesTier,
    annualSales: latest.annualSales,
    prefecture: latest.prefecture,
    profile: latest.profile,
  });
  return { messages: [flex] };
}

/** 「配信履歴」 → 直近5件をテキストで（Flex化は将来） */
async function buildHistoryMessage(lineUserId) {
  const history = await getRecentDeliveries(lineUserId, 5);
  if (history.length === 0) {
    return { messages: [txt(NO_HISTORY_TEXT)] };
  }
  const lines = ["📰 直近の配信履歴 (" + history.length + "件)\n"];
  for (const h of history) {
    const date = h.delivered_at
      ? new Date(h.delivered_at).toLocaleDateString("ja-JP", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
      : "—";
    const fb =
      h.feedback === "helpful"
        ? "👍"
        : h.feedback === "not_helpful"
        ? "👎"
        : "・";
    lines.push(
      fb + " [" + date + "] " + (h.company_name || "—") + " / " +
      (h.title || "（無題）")
    );
  }
  return { messages: [txt(lines.join("\n"))] };
}

/** 「話を聞きたい一覧」 → ユーザーの未消化申請をテキストで */
async function buildOffersMessage(lineUserId) {
  const pending = await getPendingMatchingForUser(lineUserId, 10);
  if (pending.length === 0) {
    return { messages: [txt(NO_OFFERS_TEXT)] };
  }
  const lines = ["💬 申請中の「話を聞きたい」 (" + pending.length + "件)\n"];
  for (const p of pending) {
    const date = p.requested_at
      ? new Date(p.requested_at).toLocaleDateString("ja-JP", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
      : "—";
    lines.push(
      "・[" + date + "] " + (p.company_name || "—") +
      (p.prefecture ? " (" + p.prefecture + ")" : "") +
      (p.source_title ? "\n   ↳ " + p.source_title : "")
    );
  }
  lines.push(
    "\n他の参加者が一定数集まったタイミングで、事務局がオンライン相談会を企画します🙏"
  );
  return { messages: [txt(lines.join("\n"))] };
}

/** 「設定」 → 現在の interests を表示 + Quick Reply で追加可能 */
async function buildSettingsMessage(lineUserId) {
  const prefs = await getUserPreferences(lineUserId);
  const cats = prefs.interests || [];
  if (cats.length === 0) {
    return {
      messages: [
        txt(SETTINGS_NO_INTERESTS_TEXT, buildCategoryQuickReply()),
      ],
    };
  }
  const tagText = cats.map((c) => "✓ " + c).join("\n");
  return {
    messages: [
      txt(
        "現在の関心テーマ:\n" + tagText + "\n\n" + SETTINGS_INTRO_TEXT,
        buildCategoryQuickReply()
      ),
    ],
  };
}

/** 「設定 → リセット」 → interests を NULL に戻し、QR で再選択を促す */
async function buildSettingsResetMessage(lineUserId) {
  await clearUserInterests(lineUserId);
  return {
    messages: [txt(SETTINGS_RESET_DONE_TEXT, buildCategoryQuickReply())],
  };
}

/**
 * 公開API: postback の item ごとに振り分け。
 *   item=profile  | history | offers | settings | settings_reset
 */
async function dispatchMenuPostback(lineUserId, item) {
  switch (item) {
    case "profile":
      return buildProfileMessage(lineUserId);
    case "history":
      return buildHistoryMessage(lineUserId);
    case "offers":
      return buildOffersMessage(lineUserId);
    case "settings":
      return buildSettingsMessage(lineUserId);
    case "settings_reset":
      return buildSettingsResetMessage(lineUserId);
    default:
      return {
        messages: [txt("未知のメニュー項目です: " + item)],
      };
  }
}

module.exports = {
  dispatchMenuPostback,
  buildProfileMessage,
  buildHistoryMessage,
  buildOffersMessage,
  buildSettingsMessage,
  buildSettingsResetMessage,
  // テスト用にカテゴリ一覧も export
  CATEGORIES,
};
