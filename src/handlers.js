// LINE Webhook イベントハンドラ
const {
  getOrCreateUser,
  markNotApproved,
  saveAwaitingPrefecture,
  getPendingCompanyInput,
  savePendingProfile,
  commitPendingProfile,
  discardPendingProfile,
  addUserInterest,
  addUserDislikedCategory,
  setDeliveryFeedback,
  getInitiativeById,
  getPool,
  setPendingInterestPicks,
  consumePendingInterestPick,
} = require("./db");
const {
  parseCompanyAndUrl,
  checkApproval,
  resolveByPrefecture,
  uniquePrefectures,
  buildProfileForApproved,
} = require("./onboarding");
const {
  buildProfileConfirmFlex,
  buildSingleDeliveryFlex,
  buildPrefectureQuickReply,
} = require("./flex");
const { recordMatchingRequest } = require("./matching");
const { recommendForUser } = require("./recommend");
const { buildCategoryQuickReply } = require("./categories");

const WELCOME_TEXT =
  "ようこそ「100億宣言支援AI」へ！\n\n" +
  "本サービスは、100億宣言の認可を受けている企業様向けです。\n" +
  "御社名と会社サイトのURLを教えてください。\n\n" +
  "例：\n株式会社○○\nhttps://example.co.jp";

const FORMAT_HINT_TEXT =
  "うまく読み取れませんでした🙏\n" +
  "下記のように、会社名と URL を一緒に送ってください。\n\n" +
  "例：\n株式会社○○\nhttps://example.co.jp";

const BUSY_TEXT =
  "御社が認可済企業に該当するか確認し、AIが下調べを行います…（約10〜30秒）";

const NOT_APPROVED_TEXT =
  "申し訳ありません🙏\n" +
  "現在のリストでは「100億宣言」の認可済企業として確認できませんでした。\n" +
  "認可手続きや、お名前の表記違いの可能性がございます。" +
  "事務局までお問い合わせください。";

const CONFIRMED_TEXT =
  "ありがとうございます！プロファイルを保存しました。\n" +
  "さっそく1件、御社向けに選んだ事例をお送りします👇";

const INITIAL_DELIVERY_INTRO =
  "今後は週1で「自社よりも先のフェーズ」の認可企業の取り組みを" +
  "御社向けにお届けします。気になる企業があれば「話を聞きたい」を、" +
  "記事の方向性については「マッチ」「マッチせず」で教えてください🙏";

const RESTART_TEXT =
  "了解しました。改めて、御社名と会社サイトのURLを教えてください。\n\n" +
  "例：\n株式会社○○\nhttps://example.co.jp";

const PREFECTURE_PROMPT_TEXT =
  "認可リストに同じ会社名が複数あります🙏\n" +
  "御社の本社所在地（都道府県）を下記から選んでください👇";

const AWAITING_PREFECTURE_HINT_TEXT =
  "お送りいただいた会社名で複数候補があります。\n" +
  "下のメッセージのボタンから本社所在地（都道府県）を選んでください🙏";

const PREFECTURE_NO_MATCH_TEXT =
  "申し訳ありません🙏\n" +
  "選択された都道府県では認可済企業として該当が見つかりませんでした。\n" +
  "もう一度、会社名とURLを送り直してください。";

const HEAR_THANKS_TEXT =
  "ありがとうございます！\n" +
  "「話を聞きたい」を承りました。\n\n" +
  "他の方からも同じ企業への希望が一定数集まったタイミングで、" +
  "事務局がオンライン相談会を企画して改めてご案内します。\n" +
  "（おおむね3営業日以内に事務局からご連絡いたします）";

const FEEDBACK_HELPFUL_TEXT =
  "ありがとうございます！\n" +
  "今後も同じ方向性の事例を優先してお届けします📨";

const FEEDBACK_NOT_HELPFUL_TEXT =
  "教えてくれてありがとうございます🙏\n" +
  "御社が興味のあるテーマを下記から1〜2個選んでもらえると、" +
  "次回からの記事の精度が上がります。";

// 1度目の interest 選択直後（QRをもう一度だけ出す）
const INTEREST_RECEIVED_MORE_TEXT =
  "ありがとうございます！\n" +
  "「{cat}」を関心テーマに追加しました。\n" +
  "もう1つだけ、あれば教えてください👇";

// 2度目（=最終）の interest 選択直後（QRは出さない）
const INTEREST_RECEIVED_FINAL_TEXT =
  "ありがとうございます！\n" +
  "「{cat}」も追加しました。\n\n" +
  "選んでいただいたテーマに合った情報を、これからお届けします📨\n" +
  "（後から追加・変更したくなったら、配信のフィードバックボタンから再度お選びください）";

/** follow（友だち追加）イベント */
async function handleFollow(client, event) {
  const userId = event.source.userId;
  if (userId) await getOrCreateUser(userId);
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: WELCOME_TEXT }],
  });
}

/** テキストメッセージ */
async function handleTextMessage(client, event) {
  const userId = event.source.userId;
  const text = event.message.text;

  const user = await getOrCreateUser(userId);

  if (user.state === "AWAITING_CONFIRM") {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text:
            "現在、AIが下調べした内容の確認待ちです。\n" +
            "上のカードの「これでOK」または「やり直す」を押してください。",
        },
      ],
    });
    return;
  }

  if (user.state === "AWAITING_PREFECTURE") {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text: AWAITING_PREFECTURE_HINT_TEXT,
        },
      ],
    });
    return;
  }

  const parsed = parseCompanyAndUrl(text);
  if (!parsed) {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: FORMAT_HINT_TEXT }],
    });
    return;
  }

  let approval;
  try {
    approval = await checkApproval(parsed.companyName);
  } catch (err) {
    console.error("[handlers] approval check failed:", err);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text:
            "確認中にエラーが発生しました🙏 少し時間をおいて再送してください。",
        },
      ],
    });
    return;
  }

  if (!approval.matched) {
    await markNotApproved(userId, parsed.companyName, parsed.companyUrl);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: NOT_APPROVED_TEXT }],
    });
    return;
  }

  if (approval.ambiguous) {
    console.warn(
      "[handlers] ambiguous match for",
      parsed.companyName,
      "->",
      approval.allCandidates.map((c) => c.corporate_number)
    );
    const prefectures = uniquePrefectures(approval.allCandidates);
    if (prefectures.length >= 2) {
      // 都道府県で絞り込めるケース：AWAITING_PREFECTURE に遷移して QR を出す
      await saveAwaitingPrefecture(
        userId,
        parsed.companyName,
        parsed.companyUrl
      );
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: PREFECTURE_PROMPT_TEXT,
            quickReply: buildPrefectureQuickReply(prefectures),
          },
        ],
      });
      return;
    }
    // 都道府県情報で絞り込めないレアケース：先頭採用（既存挙動）
    console.warn(
      "[handlers] cannot disambiguate by prefecture, falling back to first candidate"
    );
  }

  await runProfileGeneration(client, {
    userId,
    replyToken: event.replyToken,
    companyName: parsed.companyName,
    companyUrl: parsed.companyUrl,
    approvedCompany: approval.candidate,
  });
}

/**
 * 認可済企業を1社特定したあとの共通フロー：
 *   replyToken で BUSY テキストを返す → ローディングアニメ → AI生成 → push
 */
async function runProfileGeneration(client, args) {
  const { userId, replyToken, companyName, companyUrl, approvedCompany } = args;

  if (replyToken) {
    try {
      await client.replyMessage({
        replyToken,
        messages: [{ type: "text", text: BUSY_TEXT }],
      });
    } catch (e) {
      console.warn("[handlers] BUSY reply failed:", e.message);
    }
  } else {
    await client.pushMessage({
      to: userId,
      messages: [{ type: "text", text: BUSY_TEXT }],
    });
  }

  try {
    if (typeof client.showLoadingAnimation === "function") {
      await client.showLoadingAnimation({ chatId: userId, loadingSeconds: 30 });
    }
  } catch (e) {
    console.warn("[handlers] showLoadingAnimation failed:", e.message);
  }

  try {
    const { profile, annualSales, salesTier } = await buildProfileForApproved({
      companyName,
      companyUrl,
      approvedCompany,
    });

    await savePendingProfile({
      lineUserId: userId,
      companyName,
      companyUrl,
      approvedCompanyId: approvedCompany.id,
      annualSales,
      salesTier,
      profile,
    });

    const flex = buildProfileConfirmFlex({
      companyName,
      companyUrl,
      profile,
      salesTier,
      annualSales,
    });

    await client.pushMessage({ to: userId, messages: [flex] });
  } catch (err) {
    console.error("[handlers] profile generation failed:", err);
    await client.pushMessage({
      to: userId,
      messages: [
        {
          type: "text",
          text:
            "申し訳ありません、AIの下調べ中にエラーが発生しました🙏\n" +
            "もう一度、会社名とURLを送り直してください。",
        },
      ],
    });
  }
}

/**
 * オンボ確定直後に1件 push
 */
async function pushFirstDelivery(client, lineUserId) {
  try {
    const recs = await recommendForUser(lineUserId, 1);
    if (recs.length === 0) {
      console.log(
        "[handlers] no initial recommendation for " +
          lineUserId +
          " (skip first delivery)"
      );
      return;
    }
    const init = recs[0];
    const flex = buildSingleDeliveryFlex(init);
    await client.pushMessage({
      to: lineUserId,
      messages: [
        { type: "text", text: INITIAL_DELIVERY_INTRO },
        flex,
      ],
    });
    const pool = getPool();
    await pool.execute(
      "INSERT IGNORE INTO DeliveryLog (line_user_id, initiative_id) VALUES (?, ?)",
      [lineUserId, init.id]
    );
  } catch (err) {
    console.error("[handlers] pushFirstDelivery failed:", err);
  }
}

/**
 * postback ハンドラ
 *   action=confirm
 *   action=retry
 *   action=prefecture&value=東京都
 *   action=hear&initiative_id=X&company_id=Y
 *   action=feedback&initiative_id=X&value=helpful|not_helpful
 *   action=interest&category=Y
 */
async function handlePostback(client, event) {
  const userId = event.source.userId;
  const data = event.postback && event.postback.data;
  const params = new URLSearchParams(data || "");
  const action = params.get("action");

  if (action === "confirm") {
    try {
      await commitPendingProfile(userId);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: CONFIRMED_TEXT }],
      });
      await pushFirstDelivery(client, userId);
    } catch (err) {
      console.error("[handlers] commit failed:", err);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              "保存に失敗しました🙏 もう一度、会社名とURLから送り直してください。",
          },
        ],
      });
    }
    return;
  }

  if (action === "retry") {
    await discardPendingProfile(userId);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: RESTART_TEXT }],
    });
    return;
  }

  if (action === "prefecture") {
    const prefecture = params.get("value");
    if (!prefecture) {
      console.warn("[handlers] prefecture postback missing value:", data);
      return;
    }
    try {
      const pending = await getPendingCompanyInput(userId);
      if (
        !pending ||
        pending.state !== "AWAITING_PREFECTURE" ||
        !pending.companyName ||
        !pending.companyUrl
      ) {
        console.warn(
          "[handlers] prefecture postback received but no AWAITING_PREFECTURE pending:",
          { userId, state: pending && pending.state }
        );
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: RESTART_TEXT }],
        });
        await discardPendingProfile(userId);
        return;
      }

      const resolved = await resolveByPrefecture(
        pending.companyName,
        prefecture
      );
      if (!resolved.matched) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: PREFECTURE_NO_MATCH_TEXT }],
        });
        await discardPendingProfile(userId);
        return;
      }
      if (resolved.ambiguous) {
        // 同名 × 同都道府県の希少ケース：先頭採用 + 警告ログ
        console.warn(
          "[handlers] same prefecture duplicate, using first candidate:",
          {
            companyName: pending.companyName,
            prefecture,
            candidates: resolved.allCandidates.map((c) => c.corporate_number),
          }
        );
      }

      await runProfileGeneration(client, {
        userId,
        replyToken: event.replyToken,
        companyName: pending.companyName,
        companyUrl: pending.companyUrl,
        approvedCompany: resolved.candidate,
      });
    } catch (err) {
      console.error("[handlers] prefecture postback failed:", err);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              "処理中にエラーが発生しました🙏 もう一度、会社名とURLから送り直してください。",
          },
        ],
      });
    }
    return;
  }

  if (action === "hear") {
    const initiativeId =
      parseInt(params.get("initiative_id") || "0", 10) || null;
    const companyId = parseInt(params.get("company_id") || "0", 10);
    if (!companyId) {
      console.warn("[handlers] hear postback missing company_id:", data);
      return;
    }
    try {
      await recordMatchingRequest({
        lineUserId: userId,
        targetCompanyId: companyId,
        sourceInitiativeId: initiativeId,
      });
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: HEAR_THANKS_TEXT }],
      });
    } catch (err) {
      console.error("[handlers] hear failed:", err);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              "受付中にエラーが発生しました🙏 少し時間をおいて再度お試しください。",
          },
        ],
      });
    }
    return;
  }

  if (action === "feedback") {
    const initiativeId = parseInt(params.get("initiative_id") || "0", 10);
    const value = params.get("value");
    if (!initiativeId || !["helpful", "not_helpful"].includes(value)) {
      console.warn("[handlers] feedback postback malformed:", data);
      return;
    }
    try {
      await setDeliveryFeedback(userId, initiativeId, value);

      if (value === "helpful") {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: FEEDBACK_HELPFUL_TEXT }],
        });
        return;
      }

      // not_helpful → カテゴリQuick Reply 表示（最大2回表示の起点）
      const init = await getInitiativeById(initiativeId);
      if (init && init.category) {
        await addUserDislikedCategory(userId, init.category);
      }
      // pending=1 にしておくと、次の interest 選択時にもう一度QRを出してから打ち止めになる
      await setPendingInterestPicks(userId, 1);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: FEEDBACK_NOT_HELPFUL_TEXT,
            quickReply: buildCategoryQuickReply(),
          },
        ],
      });
    } catch (err) {
      console.error("[handlers] feedback failed:", err);
    }
    return;
  }

  if (action === "interest") {
    const cat = params.get("category");
    if (!cat) {
      console.warn("[handlers] interest postback missing category:", data);
      return;
    }
    try {
      await addUserInterest(userId, cat);
      const showAgain = await consumePendingInterestPick(userId);
      if (showAgain) {
        // QR をもう1回だけ出す
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: INTEREST_RECEIVED_MORE_TEXT.replace("{cat}", cat),
              quickReply: buildCategoryQuickReply(),
            },
          ],
        });
      } else {
        // 打ち止め
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: INTEREST_RECEIVED_FINAL_TEXT.replace("{cat}", cat),
            },
          ],
        });
      }
    } catch (err) {
      console.error("[handlers] interest failed:", err);
    }
    return;
  }

  console.warn("[handlers] unknown postback data:", data);
}

/** 単一イベントのディスパッチ */
async function handleEvent(client, event) {
  if (event.type === "follow") return handleFollow(client, event);
  if (event.type === "message" && event.message.type === "text") {
    return handleTextMessage(client, event);
  }
  if (event.type === "postback") return handlePostback(client, event);
  return null;
}

module.exports = { handleEvent };
