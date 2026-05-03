// LINE Flex Message テンプレート

const TIER_LABEL = {
  UNDER_10: "〜10億円",
  "10_30": "10〜30億円",
  "30_50": "30〜50億円",
  "50_100": "50〜100億円",
  OVER_100: "100億円以上",
};

function tierText(tier, annualSales) {
  const label = TIER_LABEL[tier] || "未分類";
  if (annualSales != null) {
    const oku = (annualSales / 100000000).toFixed(1);
    return label + " (約" + oku + "億円)";
  }
  return label;
}

function bulletList(items) {
  if (!items || items.length === 0) return "—";
  return items.map((s, i) => (i + 1) + ". " + s).join("\n");
}

function tagsText(items) {
  if (!items || items.length === 0) return "—";
  return items.map((s) => "#" + s).join("  ");
}

function section(title, body) {
  return {
    type: "box",
    layout: "vertical",
    spacing: "xs",
    contents: [
      {
        type: "text",
        text: title,
        size: "sm",
        weight: "bold",
        color: "#1F4E79",
      },
      { type: "text", text: body, size: "sm", color: "#333333", wrap: true },
    ],
  };
}

// =====================================================================
// オンボーディング確認カード
// =====================================================================
function buildProfileConfirmFlex({
  companyName,
  companyUrl,
  profile,
  salesTier,
  annualSales,
  displayName, // Phase 7-1：LINE のお名前を表示してユーザーに確認させる
}) {
  const headerContents = [
    {
      type: "text",
      text: "AIが下調べした内容",
      color: "#FFFFFF",
      size: "sm",
      weight: "bold",
    },
    {
      type: "text",
      text: companyName,
      color: "#FFFFFF",
      size: "xl",
      weight: "bold",
      wrap: true,
      margin: "sm",
    },
    {
      type: "text",
      text: companyUrl,
      color: "#CCDDEE",
      size: "xs",
      wrap: true,
      margin: "xs",
    },
  ];

  if (displayName) {
    headerContents.push({
      type: "text",
      text: "代表者: " + displayName + " 様",
      color: "#FFFFFF",
      size: "xs",
      margin: "sm",
    });
  }

  headerContents.push({
    type: "text",
    text: "売上フェーズ: " + tierText(salesTier, annualSales),
    color: "#FFFFFF",
    size: "xs",
    margin: displayName ? "xs" : "sm",
  });

  const bubble = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#1F4E79",
      paddingAll: "16px",
      contents: headerContents,
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        section("業界タグ", tagsText(profile.industry_tags)),
        section("経営テーマ", bulletList(profile.management_themes)),
        section("学びたい領域", bulletList(profile.wanted_support_areas)),
        section("強み・特徴", bulletList(profile.strengths)),
      ],
    },
    footer: {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "secondary",
          action: {
            type: "postback",
            label: "やり直す",
            data: "action=retry",
            displayText: "やり直す",
          },
        },
        {
          type: "button",
          style: "primary",
          color: "#1F4E79",
          action: {
            type: "postback",
            label: "これでOK",
            data: "action=confirm",
            displayText: "これでOK",
          },
        },
      ],
    },
  };
  return {
    type: "flex",
    altText: "【" + companyName + "】の初期プロファイルを確認してください",
    contents: bubble,
  };
}

// =====================================================================
// 配信用バブル（Phase 3: 推薦理由 + 要点 + フィードバックボタン）
// =====================================================================

/**
 * _reasons から推薦理由の説明文を生成。
 *
 * D1 (2026-05-03): reasons._dynamicReason が入っている場合（delivery_runner が
 * Claude で動的生成した文字列）はそれを優先して表示し、無ければ静的テンプレに
 * フォールバックする。
 *
 * 例（静的）:
 *  - "「DX」に関心ありとお聞きしたので、御社向けにおすすめしました"
 *  - "建設業 × DX に近い御社の次フェーズの参考事例です"
 *  - "次のフェーズの参考事例として選びました"
 */
function buildReasonText(reasons) {
  // D1: 動的生成済みのテキストがあれば最優先
  if (reasons && typeof reasons._dynamicReason === "string" && reasons._dynamicReason.trim()) {
    return reasons._dynamicReason.trim();
  }
  if (!reasons) return "次のフェーズの参考事例として選びました。";
  const r = reasons;
  if (r.interests && r.interests.length > 0) {
    return (
      "「" +
      r.interests.join("／") +
      "」に関心ありとお聞きしたので、御社向けにおすすめしました。"
    );
  }
  const parts = [];
  if (r.industries && r.industries.length > 0) parts.push(r.industries[0]);
  if (r.themes && r.themes.length > 0) parts.push(r.themes[0]);
  if (parts.length > 0) {
    return parts.join(" × ") + " に近い御社の、次フェーズの参考事例です。";
  }
  return "御社の次のフェーズに近い事例として選びました。";
}

function buildBulletText(bullets) {
  if (!bullets || bullets.length === 0) return null;
  return bullets.map((b) => "・" + b).join("\n");
}

/** 配信1件分のバブル */
function buildInitiativeBubble(initiative) {
  const companyName = initiative.company_name || "—";
  const title = initiative.title || "（無題）";
  const summary = initiative.summary || "";
  const category = initiative.category || "";
  const detailUrl = initiative.detail_url;
  const cover = initiative.cover_image_url;
  const reasons = initiative._reasons;
  const bullets = initiative.bullet_points;

  const bubble = {
    type: "bubble",
    size: "mega",
  };

  if (cover) {
    bubble.hero = {
      type: "image",
      url: cover,
      size: "full",
      aspectRatio: "20:13",
      aspectMode: "cover",
    };
  }

  const bodyContents = [
    // 企業名 + カテゴリバッジ
    {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: companyName,
          size: "xs",
          color: "#666666",
          weight: "bold",
          wrap: true,
          flex: 5,
        },
        ...(category
          ? [
              {
                type: "text",
                text: category,
                size: "xxs",
                color: "#1F4E79",
                weight: "bold",
                align: "end",
                gravity: "center",
                flex: 0,
              },
            ]
          : []),
      ],
    },
    // タイトル
    {
      type: "text",
      text: title,
      size: "md",
      weight: "bold",
      wrap: true,
      color: "#1F4E79",
    },
    // 推薦理由（あなたへ）
    {
      type: "box",
      layout: "vertical",
      backgroundColor: "#EAF1F8",
      cornerRadius: "md",
      paddingAll: "8px",
      contents: [
        {
          type: "text",
          text: "あなたへ",
          size: "xxs",
          color: "#1F4E79",
          weight: "bold",
        },
        {
          type: "text",
          text: buildReasonText(reasons),
          size: "xs",
          color: "#333333",
          wrap: true,
          margin: "xs",
        },
      ],
    },
  ];

  // 要点（あれば）
  const bulletText = buildBulletText(bullets);
  if (bulletText) {
    bodyContents.push({
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: "要点",
          size: "xs",
          color: "#1F4E79",
          weight: "bold",
        },
        {
          type: "text",
          text: bulletText,
          size: "sm",
          wrap: true,
          color: "#333333",
          margin: "xs",
        },
      ],
    });
  } else if (summary) {
    bodyContents.push({
      type: "text",
      text: summary,
      size: "sm",
      wrap: true,
      color: "#333333",
    });
  }

  bubble.body = {
    type: "box",
    layout: "vertical",
    spacing: "md",
    contents: bodyContents,
  };

  // フッター
  const topRowButtons = [];
  if (detailUrl) {
    topRowButtons.push({
      type: "button",
      style: "secondary",
      height: "sm",
      action: {
        type: "uri",
        label: "詳細を見る",
        uri: detailUrl,
      },
    });
  }
  topRowButtons.push({
    type: "button",
    style: "primary",
    color: "#1F4E79",
    height: "sm",
    action: {
      type: "postback",
      label: "話を聞きたい",
      data:
        "action=hear&initiative_id=" +
        encodeURIComponent(initiative.id) +
        "&company_id=" +
        encodeURIComponent(initiative.approved_company_id),
      displayText: companyName + " の話を聞きたい",
    },
  });

  // フィードバック行 (マッチ / マッチせず)
  const feedbackRow = {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    contents: [
      {
        type: "button",
        style: "link",
        height: "sm",
        action: {
          type: "postback",
          label: "👍 マッチ",
          data:
            "action=feedback&initiative_id=" +
            encodeURIComponent(initiative.id) +
            "&value=helpful",
          displayText: "当社にマッチします！",
        },
      },
      {
        type: "button",
        style: "link",
        height: "sm",
        action: {
          type: "postback",
          label: "👎 マッチせず",
          data:
            "action=feedback&initiative_id=" +
            encodeURIComponent(initiative.id) +
            "&value=not_helpful",
          displayText: "当社にはマッチしないかも",
        },
      },
    ],
  };

  bubble.footer = {
    type: "box",
    layout: "vertical",
    spacing: "sm",
    contents: [...topRowButtons, feedbackRow],
  };

  return bubble;
}

/**
 * カルーセル形式（週1配信用、最大10件）
 */
function buildDeliveryCarouselFlex(initiatives) {
  const list = (initiatives || []).slice(0, 10);
  const altSummary = list
    .map((i) => i.title)
    .filter(Boolean)
    .join(" / ");
  return {
    type: "flex",
    altText:
      "【今週のおすすめ事例】" +
      (altSummary ? " " + altSummary : "（取り組み事例）"),
    contents: {
      type: "carousel",
      contents: list.map(buildInitiativeBubble),
    },
  };
}

/**
 * 単一バブル形式（オンボーディング直後の初回配信用）
 */
function buildSingleDeliveryFlex(initiative) {
  return {
    type: "flex",
    altText:
      "【あなたへの初回おすすめ】" +
      (initiative && initiative.title ? " " + initiative.title : ""),
    contents: buildInitiativeBubble(initiative),
  };
}

// =====================================================================
// 同名衝突時の都道府県選択 Quick Reply
// =====================================================================

/**
 * 候補となる都道府県の配列から Quick Reply の items を組み立てる。
 * 末尾に「やり直す」を1件付ける（既存の action=retry を再利用）。
 *
 * LINE の Quick Reply は最大13件。候補都道府県は実データ上 2〜3件想定だが、
 * 念のため12件で切って末尾に retry を追加する。
 */
function buildPrefectureQuickReply(prefectures) {
  const list = (prefectures || []).filter(Boolean).slice(0, 12);
  const items = list.map((p) => ({
    type: "action",
    action: {
      type: "postback",
      label: p.length > 20 ? p.slice(0, 19) + "…" : p,
      data: "action=prefecture&value=" + encodeURIComponent(p),
      displayText: p,
    },
  }));
  items.push({
    type: "action",
    action: {
      type: "postback",
      label: "やり直す",
      data: "action=retry",
      displayText: "やり直す",
    },
  });
  return { items };
}

// =====================================================================
// リッチメニュー「マイプロファイル」用 Flex (#24)
// =====================================================================

/**
 * 確定済みプロファイルを Flex でビジュアル表示。
 *  - companyName / companyUrl / salesTier / prefecture
 *  - profile.industry_tags / management_themes / wanted_support_areas / strengths
 */
function buildMyProfileFlex({
  companyName,
  companyUrl,
  salesTier,
  annualSales,
  prefecture,
  profile,
}) {
  const safeProfile = profile || {};
  const tier = tierText(salesTier, annualSales);

  const bubble = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#1F4E79",
      paddingAll: "16px",
      contents: [
        {
          type: "text",
          text: "あなたのプロファイル",
          color: "#FFFFFF",
          size: "sm",
          weight: "bold",
        },
        {
          type: "text",
          text: companyName || "—",
          color: "#FFFFFF",
          size: "xl",
          weight: "bold",
          wrap: true,
          margin: "sm",
        },
        ...(companyUrl
          ? [
              {
                type: "text",
                text: companyUrl,
                color: "#CCDDEE",
                size: "xs",
                wrap: true,
                margin: "xs",
              },
            ]
          : []),
        {
          type: "text",
          text: "売上フェーズ: " + tier +
            (prefecture ? "  /  " + prefecture : ""),
          color: "#FFFFFF",
          size: "xs",
          margin: "sm",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        section("業界タグ", tagsText(safeProfile.industry_tags)),
        section("経営テーマ", bulletList(safeProfile.management_themes)),
        section("学びたい領域", bulletList(safeProfile.wanted_support_areas)),
        section("強み・特徴", bulletList(safeProfile.strengths)),
      ],
    },
    footer: {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: {
            type: "postback",
            label: "やり直す",
            data: "action=retry",
            displayText: "プロファイルをやり直す",
          },
        },
      ],
    },
  };

  return {
    type: "flex",
    altText: "【マイプロファイル】" + (companyName || ""),
    contents: bubble,
  };
}

// =====================================================================
// 参加打診 Flex Message (Phase 3b-2)
// =====================================================================

function fmtJpDateTime(d) {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  const opt = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  };
  try {
    return new Intl.DateTimeFormat("ja-JP", opt).format(date);
  } catch (_e) {
    return String(d);
  }
}

/**
 * 相談会への参加打診カード。
 *  event = {
 *    id, host_company_name (or hostCompanyName), title, description,
 *    scheduled_at, duration_minutes, capacity, zoom_url,
 *  }
 */
function buildConsultationInviteFlex(event) {
  const eventId = event.id;
  const hostName =
    event.host_company_name || event.hostCompanyName || "—";
  const title = event.title || "（無題）";
  const description = event.description || "";
  const scheduledAt = event.scheduled_at || event.scheduledAt;
  const duration = event.duration_minutes || event.durationMinutes || 60;
  const capacity = event.capacity != null ? event.capacity : 0;
  const zoomUrl = event.zoom_url || event.zoomUrl;

  const bodyContents = [
    {
      type: "text",
      text: hostName + " 主催",
      size: "xs",
      color: "#666666",
    },
    {
      type: "text",
      text: title,
      size: "md",
      weight: "bold",
      color: "#1F4E79",
      wrap: true,
    },
    {
      type: "box",
      layout: "vertical",
      backgroundColor: "#EAF1F8",
      cornerRadius: "md",
      paddingAll: "10px",
      contents: [
        section("📅 日時", fmtJpDateTime(scheduledAt)),
        section("⏱ 所要時間", duration + " 分"),
        ...(capacity > 0 ? [section("👥 定員", capacity + " 名")] : []),
      ],
    },
  ];

  if (description) {
    bodyContents.push({
      type: "text",
      text: description,
      size: "sm",
      wrap: true,
      color: "#333333",
    });
  }

  // フッター
  const buttons = [
    {
      type: "button",
      style: "secondary",
      height: "sm",
      action: {
        type: "postback",
        label: "キャンセル",
        data: "action=consult&event_id=" + encodeURIComponent(eventId) + "&value=decline",
        displayText: "今回は参加を見送ります",
      },
    },
    {
      type: "button",
      style: "primary",
      color: "#1F4E79",
      height: "sm",
      action: {
        type: "postback",
        label: "参加する",
        data: "action=consult&event_id=" + encodeURIComponent(eventId) + "&value=join",
        displayText: "参加します",
      },
    },
  ];

  // Zoom URL があれば、参加表明の後にリンクボタンを別行で表示する
  // （事前にURLを見せるとキャンセルを促す可能性があるので、参加ボタンとは別扱い）
  const footerRows = [
    { type: "box", layout: "horizontal", spacing: "sm", contents: buttons },
  ];

  const bubble = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#1F4E79",
      paddingAll: "16px",
      contents: [
        {
          type: "text",
          text: "📣 相談会のお知らせ",
          color: "#FFFFFF",
          size: "sm",
          weight: "bold",
        },
        {
          type: "text",
          text: "ご希望いただいた企業の相談会が開催されます",
          color: "#CCDDEE",
          size: "xs",
          margin: "xs",
          wrap: true,
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: bodyContents,
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: footerRows,
    },
  };

  // zoom_url を notes 的に最下部に小さく出す（任意。参加表明後に再送する設計でも良い）
  if (zoomUrl) {
    bubble.footer.contents.push({
      type: "text",
      text: "※ Zoom URL は「参加する」を押した後にお知らせします",
      size: "xxs",
      color: "#888888",
      align: "center",
      wrap: true,
    });
  }

  return {
    type: "flex",
    altText: "【相談会のお知らせ】" + hostName + " / " + title,
    contents: bubble,
  };
}

// =====================================================================
// 開催前リマインド / 開催後アーカイブ Flex (Phase 3b-3)
// =====================================================================

/**
 * 開催前リマインドカード。
 *  event = { id, host_company_name, title, scheduled_at, duration_minutes, zoom_url }
 */
function buildConsultationReminderFlex(event) {
  const hostName = event.host_company_name || event.hostCompanyName || "—";
  const title = event.title || "（無題）";
  const scheduledAt = event.scheduled_at || event.scheduledAt;
  const duration = event.duration_minutes || event.durationMinutes || 60;
  const zoomUrl = event.zoom_url || event.zoomUrl;

  const bodyContents = [
    {
      type: "text",
      text: hostName + " 主催",
      size: "xs",
      color: "#666666",
    },
    {
      type: "text",
      text: title,
      size: "md",
      weight: "bold",
      color: "#1F4E79",
      wrap: true,
    },
    {
      type: "box",
      layout: "vertical",
      backgroundColor: "#FFF7E6",
      cornerRadius: "md",
      paddingAll: "10px",
      contents: [
        section("📅 開催日時", fmtJpDateTime(scheduledAt)),
        section("⏱ 所要時間", duration + " 分"),
      ],
    },
    {
      type: "text",
      text: "お時間になりましたら下のリンクからご参加ください。",
      size: "sm",
      color: "#333333",
      wrap: true,
    },
  ];

  const footerButtons = [];
  if (zoomUrl) {
    footerButtons.push({
      type: "button",
      style: "primary",
      color: "#1F4E79",
      height: "sm",
      action: {
        type: "uri",
        label: "Zoom で参加",
        uri: zoomUrl,
      },
    });
  }

  const bubble = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#E89F2A",
      paddingAll: "16px",
      contents: [
        {
          type: "text",
          text: "⏰ 相談会のリマインド",
          color: "#FFFFFF",
          size: "sm",
          weight: "bold",
        },
        {
          type: "text",
          text: "もうすぐ開催です。お忘れなく！",
          color: "#FFEEDD",
          size: "xs",
          margin: "xs",
          wrap: true,
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: bodyContents,
    },
    footer: footerButtons.length > 0
      ? {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: footerButtons,
        }
      : undefined,
  };

  return {
    type: "flex",
    altText: "【リマインド】" + hostName + " / " + title,
    contents: bubble,
  };
}

/**
 * 開催後アーカイブ配信カード。
 *  event = { id, host_company_name, title, scheduled_at, archive_url }
 */
function buildConsultationArchiveFlex(event) {
  const hostName = event.host_company_name || event.hostCompanyName || "—";
  const title = event.title || "（無題）";
  const scheduledAt = event.scheduled_at || event.scheduledAt;
  const archiveUrl = event.archive_url || event.archiveUrl;

  const bodyContents = [
    {
      type: "text",
      text: hostName + " 主催",
      size: "xs",
      color: "#666666",
    },
    {
      type: "text",
      text: title,
      size: "md",
      weight: "bold",
      color: "#1F4E79",
      wrap: true,
    },
    {
      type: "box",
      layout: "vertical",
      backgroundColor: "#EAF1F8",
      cornerRadius: "md",
      paddingAll: "10px",
      contents: [
        section("📅 開催日時", fmtJpDateTime(scheduledAt)),
      ],
    },
    {
      type: "text",
      text:
        "ご参加ありがとうございました🙏\n" +
        "アーカイブ動画/資料を下記からご覧いただけます。",
      size: "sm",
      color: "#333333",
      wrap: true,
    },
  ];

  const footerButtons = [];
  if (archiveUrl) {
    footerButtons.push({
      type: "button",
      style: "primary",
      color: "#1F4E79",
      height: "sm",
      action: {
        type: "uri",
        label: "アーカイブを見る",
        uri: archiveUrl,
      },
    });
  }

  const bubble = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#1F4E79",
      paddingAll: "16px",
      contents: [
        {
          type: "text",
          text: "📺 アーカイブのお知らせ",
          color: "#FFFFFF",
          size: "sm",
          weight: "bold",
        },
        {
          type: "text",
          text: "先日の相談会のアーカイブを公開しました",
          color: "#CCDDEE",
          size: "xs",
          margin: "xs",
          wrap: true,
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: bodyContents,
    },
    footer: footerButtons.length > 0
      ? {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: footerButtons,
        }
      : undefined,
  };

  return {
    type: "flex",
    altText: "【アーカイブ公開】" + hostName + " / " + title,
    contents: bubble,
  };
}

module.exports = {
  buildProfileConfirmFlex,
  buildDeliveryCarouselFlex,
  buildSingleDeliveryFlex,
  buildInitiativeBubble,
  buildReasonText,
  buildPrefectureQuickReply,
  buildMyProfileFlex,
  buildConsultationInviteFlex,
  buildConsultationReminderFlex,
  buildConsultationArchiveFlex,
};
