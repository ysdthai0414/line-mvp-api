// アプリケーションエラー通知 (A3 エラー監視)
//
// 主に Slack（or コンソール fallback）にエラーを通知するユーティリティ。
//
// 使い方:
//   const { notifyError } = require("./error_notifier");
//   try { ... } catch (err) {
//     await notifyError(err, { source: "webhook", lineUserId, eventType });
//   }
//
// 特徴:
//   - 重複抑制: 同じ「エラー指紋」（message + stack先頭行）が短時間に
//     何度も発生してもN秒以内は1回だけ通知（Slackがエラーで埋まるのを防ぐ）
//   - 設定値:
//       ERROR_NOTIFY_WINDOW_SECONDS  デフォルト 300 (= 5分)
//       ERROR_NOTIFY_DISABLED         true でこのモジュールごと無効化
//   - 通知の送信先選択ロジックは既存 src/notify.js の sendNotification に委譲
//   - resetCache() でテスト時にメモリをクリアできる

// 注意: destructuring せず module オブジェクト経由で参照する。
// こうしておくと、テストで notifyMod.sendNotification を差し替えたとき
// 本モジュールも書き換え後の関数を呼ぶようになる（共有 require cache の利点）。
const notifyMod = require("./notify");

const DEFAULT_WINDOW_SECONDS = 300;

// エラー指紋 → 最後の通知時刻 (ms)
const lastNotifiedByFingerprint = new Map();

function getWindowSeconds() {
  const v = parseInt(process.env.ERROR_NOTIFY_WINDOW_SECONDS || "", 10);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_WINDOW_SECONDS;
  return v;
}

function isDisabled() {
  return (process.env.ERROR_NOTIFY_DISABLED || "").toLowerCase() === "true";
}

/**
 * Error → 文字列化（Error/string/object 何でも受け取る）
 */
function describe(err) {
  if (err == null) return { message: "(null error)", stack: "", name: "Error" };
  if (err instanceof Error) {
    return {
      message: err.message || "(no message)",
      stack: err.stack || "",
      name: err.name || "Error",
    };
  }
  if (typeof err === "string") {
    return { message: err, stack: "", name: "Error" };
  }
  // その他は JSON 化
  let m;
  try { m = JSON.stringify(err); } catch (_e) { m = String(err); }
  return { message: m.slice(0, 500), stack: "", name: "Error" };
}

/**
 * 指紋: name + message先頭120文字 + stack 先頭1行
 */
function fingerprint(err) {
  const d = describe(err);
  const stackHead = (d.stack.split("\n")[1] || "").trim();
  return d.name + "|" + d.message.slice(0, 120) + "|" + stackHead;
}

function shouldSuppress(fp, nowMs, windowSec) {
  const last = lastNotifiedByFingerprint.get(fp);
  if (!last) return false;
  return (nowMs - last) < (windowSec * 1000);
}

/**
 * 公開API: エラーを通知する。
 *   args:
 *     err     必須。Error / string / 何でも
 *     context 任意。{ source, lineUserId, eventType, ... } を Slack の fields に出す
 *   options（テスト用）:
 *     dryRun         sendNotification をdryRun で呼ぶ
 *     now            時刻を固定（重複抑制テスト用）
 */
async function notifyError(err, context = {}, options = {}) {
  if (isDisabled()) {
    return { ok: true, suppressed: true, reason: "disabled" };
  }

  const d = describe(err);
  const fp = fingerprint(err);
  const nowMs = options.now != null ? Number(options.now) : Date.now();
  const windowSec = getWindowSeconds();

  if (shouldSuppress(fp, nowMs, windowSec)) {
    // ログには残す（軽く）
    console.warn(
      "[error_notifier] suppressed (rate-limited): " + d.name + ": " +
      d.message.slice(0, 200)
    );
    return { ok: true, suppressed: true, reason: "rate_limited" };
  }

  const fields = {};
  for (const [k, v] of Object.entries(context || {})) {
    if (v == null) continue;
    fields[k] = typeof v === "string" ? v : JSON.stringify(v);
  }

  const stackHead = d.stack.split("\n").slice(0, 6).join("\n"); // 上位6行
  const summary =
    "**" + d.name + "**: " + d.message.slice(0, 500) +
    (stackHead ? "\n```\n" + stackHead + "\n```" : "");

  const sendArgs = {
    title: "🚨 アプリエラー: " + d.name,
    summary,
    fields,
    dryRun: !!options.dryRun,
  };

  let res;
  try {
    res = await notifyMod.sendNotification(sendArgs);
  } catch (err2) {
    // sendNotification 自体が失敗した場合のフェイルセーフ
    console.error(
      "[error_notifier] sendNotification failed:",
      (err2 && err2.message) || err2
    );
    return { ok: false, suppressed: false, error: err2.message || String(err2) };
  }

  // 成功したら指紋を記録（dryRunの場合も記録するとテストが噛むので、dryRun時は記録しない）
  if (!options.dryRun) {
    lastNotifiedByFingerprint.set(fp, nowMs);
  }

  return {
    ok: !!(res && res.ok),
    suppressed: false,
    channel: res && res.channel,
    status: res && res.status,
    fingerprint: fp,
  };
}

/** テスト用：重複抑制キャッシュをクリア */
function resetCache() {
  lastNotifiedByFingerprint.clear();
}

module.exports = {
  notifyError,
  resetCache,
  // 内部関数も export（テスト用）
  describe,
  fingerprint,
  getWindowSeconds,
};
