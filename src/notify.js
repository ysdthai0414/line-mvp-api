// 通知モジュール
//
// SLACK_WEBHOOK_URL が設定されていれば Slack に POST し、
// 未設定ならコンソールに出力する（fallback）。
// どちらの場合も「成功 / 失敗」のステータスを返す。
//
// 使い方:
//   const { sendNotification } = require("./notify");
//   const r = await sendNotification({
//     title: "...",
//     summary: "...",
//     fields: { 件数: 5, 会社名: "..." },
//   });
//   // r = { ok: true, channel: 'slack' | 'console', status: 'sent' | 'logged', payload: {...} }

const SLACK_WEBHOOK_URL =
  process.env.SLACK_WEBHOOK_URL ||
  process.env.MATCHING_NOTIFY_SLACK_WEBHOOK_URL || // 別名も許容
  "";

const FETCH_TIMEOUT_MS = 8000;

/**
 * Slack Webhook 用のシンプルなペイロードを組み立てる。
 * 標準的な incoming webhook 互換（text + attachments）。
 */
function buildSlackPayload({ title, summary, fields, link }) {
  const fieldList = Object.entries(fields || {}).map(([k, v]) => ({
    title: String(k),
    value: String(v),
    short: true,
  }));

  return {
    text: title,
    attachments: [
      {
        color: "#1F4E79",
        title: title,
        text: summary || "",
        fields: fieldList,
        footer: "100億宣言支援AI / 事務局通知",
        ts: Math.floor(Date.now() / 1000),
        title_link: link || undefined,
      },
    ],
  };
}

/**
 * コンソール出力用に整形する。
 */
function formatForConsole({ title, summary, fields, link }) {
  const lines = [
    "===== [事務局通知] =====",
    "■ " + title,
  ];
  if (summary) lines.push(summary);
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      lines.push("  - " + k + ": " + v);
    }
  }
  if (link) lines.push("  link: " + link);
  lines.push("=======================");
  return lines.join("\n");
}

/**
 * Slack に POST。タイムアウトあり。
 */
async function postToSlack(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error("Slack POST " + res.status + ": " + text.slice(0, 200));
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 公開API: 通知を送る。
 *   args = { title, summary, fields, link, dryRun }
 *
 *   - dryRun=true: 何も送らずに「送る予定の payload」を返す
 *   - SLACK_WEBHOOK_URL あり: Slack に送信
 *   - 未設定: コンソールに出力
 */
async function sendNotification(args = {}) {
  const { dryRun = false } = args;
  const slackPayload = buildSlackPayload(args);
  const consoleText = formatForConsole(args);

  if (dryRun) {
    return {
      ok: true,
      channel: SLACK_WEBHOOK_URL ? "slack" : "console",
      status: "logged",
      payload: SLACK_WEBHOOK_URL ? slackPayload : { text: consoleText },
      dryRun: true,
    };
  }

  if (SLACK_WEBHOOK_URL) {
    try {
      await postToSlack(slackPayload);
      return {
        ok: true,
        channel: "slack",
        status: "sent",
        payload: slackPayload,
      };
    } catch (err) {
      // Slack 失敗はコンソールにフォールバックして記録する
      console.error("[notify] Slack POST failed, fallback to console:", err.message);
      console.log(consoleText);
      return {
        ok: false,
        channel: "slack",
        status: "failed",
        payload: slackPayload,
        error: err.message,
      };
    }
  }

  // Webhook 未設定 → コンソール出力（成功扱い）
  console.log(consoleText);
  return {
    ok: true,
    channel: "console",
    status: "logged",
    payload: { text: consoleText },
  };
}

module.exports = {
  sendNotification,
  buildSlackPayload,
  formatForConsole,
  // テスト・デバッグ用
  hasSlackWebhook: () => !!SLACK_WEBHOOK_URL,
};
