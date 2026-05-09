// LINE Webhook イベントハンドラ
const {
  getOrCreateUser,
  setDisplayName,
  setUserState,
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
const { attachDynamicReasons } = require("./delivery_runner");
const { buildCategoryQuickReply } = require("./categories");
const { dispatchMenuPostback } = require("./menu_handlers");
const {
  setParticipantStatus,
  getEvent,
} = require("./consultation");

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

// Phase 7-1++：プロファイル確定後に代表者名を聞くテキスト（テンプレ）
function buildRepNameQuestionText(currentDisplayName) {
  const head =
    "プロファイルを保存しました！\n" +
    "最後に、代表者のお名前を教えてください（例：吉田 航平）。";
  if (currentDisplayName) {
    return (
      head +
      "\n\n現在「" +
      currentDisplayName +
      "」で登録されています。\n" +
      "→ 合っていれば「OK」と返信。\n" +
      "→ 違う場合は正しいお名前を返信してください。"
    );
  }
  return head;
}

const REP_NAME_THANKS_TEXT =
  "ありがとうございます！\n" +
  "それでは、御社向けに選んだ事例を1件お送りします👇";

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

const CONSULT_JOIN_THANKS_TEXT_BASE =
  "ありがとうございます！相談会への参加を承りました🎉\n" +
  "開催日時が近づいたら、改めてリマインドをお送りします。";

const CONSULT_DECLINE_THANKS_TEXT =
  "教えてくださりありがとうございます。\n" +
  "今回は見送りで承知しました。今後また気になる企業の事例があれば、" +
  "ぜひお気軽に「話を聞きたい」を押してください🙏";

const CONSULT_NOT_FOUND_TEXT =
  "申し訳ありません🙏\n" +
  "対象の相談会が見つかりませんでした。事務局までお問い合わせください。";

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
  "さっそく、選んでいただいたテーマに沿った事例を一件お送りします👇";

const INTEREST_INTRO_FOR_TEST_DELIVERY =
  "（テーマ更新後の最初の事例です）";

/** follow（友だち追加）イベント */
async function handleFollow(client, event) {
  const userId = event.source.userId;
  if (userId) await getOrCreateUser(userId);

  // Phase 7-1：LINE displayName を取得して保存（管理画面で実名を表示するため）。
  // ブロック等で取得失敗してもオンボーディング自体は止めない。
  if (userId) {
    try {
      const profile = await client.getProfile(userId);
      if (profile && profile.displayName) {
        await setDisplayName(userId, profile.displayName);
      }
    } catch (err) {
      console.warn("[handlers] getProfile failed:", err.message);
    }
  }

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

  // Phase 7-1：display_name が未取得なら opportunistic に backfill
  // （Phase 7-1 デプロイ前に友だち追加していた既存ユーザー対策）
  if (!user.display_name) {
    try {
      const profile = await client.getProfile(userId);
      if (profile && profile.displayName) {
        await setDisplayName(userId, profile.displayName);
        user.display_name = profile.displayName;
      }
    } catch (err) {
      console.warn("[handlers] getProfile backfill failed:", err.message);
    }
  }

  // Phase 7-1++：プロファイル確定後の「代表者名を教えてください」回答ハンドリング
  if (user.state === "AWAITING_REP_NAME") {
    const trimmed = (text || "").trim();
    const isOk = /^(ok|OK|オッケー|オーケー|はい|それでOK|それでOK)$/i.test(trimmed);

    // OK 以外（空でなければ）のテキストは新しい代表者名として保存
    if (trimmed && !isOk) {
      try {
        await setDisplayName(userId, trimmed);
      } catch (e) {
        console.warn("[handlers] setDisplayName failed:", e.message);
      }
    }

    // 状態を CONFIRMED に進めて、初回配信を push
    try {
      await setUserState(userId, "CONFIRMED");
    } catch (e) {
      console.warn("[handlers] setUserState CONFIRMED failed:", e.message);
    }

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: REP_NAME_THANKS_TEXT }],
    });
    await pushFirstDelivery(client, userId);
    return;
  }

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
    displayName: user.display_name || null, // Phase 7-1
  });
}

/**
 * 認可済企業を1社特定したあとの共通フロー：
 *   replyToken で BUSY テキストを返す → ローディングアニメ → AI生成 → push
 */
async function runProfileGeneration(client, args) {
  const { userId, replyToken, companyName, companyUrl, approvedCompany } = args;

  // Phase 7-1：displayName が args で渡されていなければ DB から取得
  let displayName = args.displayName || null;
  if (!displayName && userId) {
    try {
      const u = await getOrCreateUser(userId);
      displayName = u.display_name || null;
    } catch (e) {
      console.warn("[handlers] runProfileGeneration: lookup display_name failed:", e.message);
    }
  }

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

    // Phase 7-1+：AI が代表者名を抽出できていれば display_name を上書き
    // （LINE 表示名より公式な代表取締役名を優先したい）
    if (profile && profile.representative_name) {
      try {
        await setDisplayName(userId, profile.representative_name);
        displayName = profile.representative_name; // Flex に渡す表示名も更新
      } catch (e) {
        console.warn("[handlers] save representative_name failed:", e.message);
      }
    }

    const flex = buildProfileConfirmFlex({
      companyName,
      companyUrl,
      profile,
      salesTier,
      annualSales,
      displayName, // Phase 7-1（AI抽出 > LINE名 > null の優先順位）
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
  return pushOneRecommendation(client, lineUserId, INITIAL_DELIVERY_INTRO);
}

/**
 * 1 件のレコメンドを push する汎用関数。
 * - オンボーディング完了直後の初回配信
 * - 「マッチせず」→ 関心テーマ選択後の即時テスト配信
 * など、任意の文脈で使い回せる。introText を null にすれば card だけ送る。
 */
async function pushOneRecommendation(client, lineUserId, introText) {
  try {
    const recs = await recommendForUser(lineUserId, 1);
    if (recs.length === 0) {
      console.log(
        "[handlers] no recommendation for " + lineUserId + " (skip push)"
      );
      return;
    }

    // Phase 7-3 fix：オンボ後の初回配信や関心テーマ更新後のテスト配信でも
    // AI 動的推薦理由 + 応用ポイントを付与する（delivery_runner と同じ仕組み）。
    // 失敗しても配信自体は止めずに静的テンプレにフォールバック。
    try {
      await attachDynamicReasons(lineUserId, recs, {
        useDynamicReason: true,
        logger: console,
      });
    } catch (e) {
      console.warn("[handlers] attachDynamicReasons in pushOneRecommendation failed:", e.message);
    }

    const init = recs[0];
    const flex = buildSingleDeliveryFlex(init);
    const messages = [];
    if (introText) messages.push({ type: "text", text: introText });
    messages.push(flex);
    await client.pushMessage({ to: lineUserId, messages });
    const pool = getPool();
    await pool.execute(
      "INSERT IGNORE INTO DeliveryLog (line_user_id, initiative_id) VALUES (?, ?)",
      [lineUserId, init.id]
    );
  } catch (err) {
    console.error("[handlers] pushOneRecommendation failed:", err);
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
 *   action=menu&item=profile|history|offers|settings|settings_reset    ← #24
 *   action=consult&event_id=N&value=join|decline                       ← Phase 3b-2
 */
async function handlePostback(client, event) {
  const userId = event.source.userId;
  const data = event.postback && event.postback.data;
  const params = new URLSearchParams(data || "");
  const action = params.get("action");

  if (action === "confirm") {
    try {
      await commitPendingProfile(userId);

      // Phase 7-1++：first delivery の前に代表者名確認ステップを挟む
      await setUserState(userId, "AWAITING_REP_NAME");
      const fresh = await getOrCreateUser(userId);
      const currentName = fresh && fresh.display_name ? fresh.display_name : null;
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: buildRepNameQuestionText(currentName),
          },
        ],
      });
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

  if (action === "menu") {
    const item = params.get("item");
    if (!item) {
      console.warn("[handlers] menu postback missing item:", data);
      return;
    }
    try {
      const { messages } = await dispatchMenuPostback(userId, item);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages,
      });
    } catch (err) {
      console.error("[handlers] menu dispatch failed:", err);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              "メニュー処理中にエラーが発生しました🙏 少し時間をおいて再度お試しください。",
          },
        ],
      });
    }
    return;
  }

  if (action === "consult") {
    const eventId = parseInt(params.get("event_id") || "0", 10);
    const value = params.get("value");
    if (!eventId || !["join", "decline"].includes(value)) {
      console.warn("[handlers] consult postback malformed:", data);
      return;
    }
    try {
      const consultEvent = await getEvent(eventId);
      if (!consultEvent) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: CONSULT_NOT_FOUND_TEXT }],
        });
        return;
      }
      const newStatus = value === "join" ? "joined" : "declined";
      const ok = await setParticipantStatus(eventId, userId, newStatus);
      if (!ok) {
        // 該当 invited なし → ユーザーは participants に登録されていない
        console.warn(
          "[handlers] consult postback: no matching participant",
          { eventId, userId, value }
        );
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                "この相談会へのご招待が確認できませんでした🙏 事務局までお問い合わせください。",
            },
          ],
        });
        return;
      }

      if (value === "join") {
        const lines = [CONSULT_JOIN_THANKS_TEXT_BASE];
        if (consultEvent.zoom_url) {
          lines.push(
            "\n👇 当日の Zoom URL：\n" + consultEvent.zoom_url
          );
        }
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: lines.join("\n") }],
        });
      } else {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: CONSULT_DECLINE_THANKS_TEXT }],
        });
      }
    } catch (err) {
      console.error("[handlers] consult postback failed:", err);
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
        // 打ち止め：reply で謝意 + 即時に 1 件テスト配信を push
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: INTEREST_RECEIVED_FINAL_TEXT.replace("{cat}", cat),
            },
          ],
        });
        // 関心テーマ更新後の最新リコメンドを 1 件 push（既存の DeliveryLog でガード）
        await pushOneRecommendation(client, userId, INTEREST_INTRO_FOR_TEST_DELIVERY);
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
