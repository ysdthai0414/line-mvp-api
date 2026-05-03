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
}) {
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
        {
          type: "text",
          text: "売上フェーズ: " + tierText(salesTier, annualSales),
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
 * 例:
 *  - "「DX」に関心ありとお聞きしたので、御社向けにおすすめしました"
 *  - "建設業 × DX に近い御社の次フェーズの参考事例です"
 *  - "次のフェーズの参考事例として選びました"
 */
function buildReasonText(reasons) {
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

module.exports = {
  buildProfileConfirmFlex,
  buildDeliveryCarouselFlex,
  buildSingleDeliveryFlex,
  buildInitiativeBubble,
  buildReasonText,
  buildPrefectureQuickReply,
};
