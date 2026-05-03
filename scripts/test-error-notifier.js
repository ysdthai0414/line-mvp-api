#!/usr/bin/env node
// =============================================================
// A3 error_notifier 単体テスト
//
// 使い方:
//   node scripts/test-error-notifier.js
//
// シナリオ:
//   1) describe(err) が Error/string/object を扱える
//   2) fingerprint が同じ Error に対して安定する（同一 message → 同一 fingerprint）
//   3) 異なる Error は異なる fingerprint
//   4) notifyError(dryRun=true) は ok=true / suppressed=false を返す
//   5) ERROR_NOTIFY_DISABLED=true で suppressed=true (reason=disabled)
//   6) 重複抑制: 同じエラーを window 内に2回 → 2回目は suppressed (reason=rate_limited)
//      ※ dryRun=true 時は記録されないので、本番モード相当の挙動を擬似的に検証する
//   7) resetCache でキャッシュクリアできる
//   8) DB / LINE API は呼ばない（純粋にJSロジックの検証）
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const errorNotifier = require("../src/error_notifier");
const {
  notifyError,
  resetCache,
  describe,
  fingerprint,
  getWindowSeconds,
} = errorNotifier;

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

// 直接 lastNotifiedByFingerprint を触れないので、本番相当の挙動を試すための
// 内部ステート操作用にラッパを用意。dryRun=falseだが sendNotification はモックで上書きする。
function mockSendNotification() {
  const calls = [];
  // require cache を上書き
  const notifyMod = require("../src/notify");
  const original = notifyMod.sendNotification;
  notifyMod.sendNotification = async (args) => {
    calls.push(args);
    return { ok: true, channel: "console", status: "logged", payload: { text: "mock" } };
  };
  return {
    calls,
    restore: () => { notifyMod.sendNotification = original; },
  };
}

async function main() {
  console.log("=== A3 error_notifier テスト ===");

  try {
    console.log("\n[STEP 1] describe(err) の網羅");
    const d1 = describe(new Error("hello"));
    check(d1.message === "hello", "Error.message");
    check(d1.name === "Error", "Error.name === 'Error'");

    const d2 = describe("plain string");
    check(d2.message === "plain string", "string → message");
    check(d2.stack === "", "string → stack === ''");

    const d3 = describe({ foo: 1 });
    check(d3.message.indexOf("foo") >= 0, "object → JSON.stringify 含む");

    const d4 = describe(null);
    check(d4.message.indexOf("null") >= 0, "null → '(null error)' 表記");

    console.log("\n[STEP 2] fingerprint の安定性");
    const e1 = new Error("same");
    const e2 = new Error("same");
    const fp1 = fingerprint(e1);
    const fp2 = fingerprint(e2);
    // stack の最初の行は呼出位置に依存するため一致するとは限らない
    // 少なくとも message 部分は同じ → 文字列に "same" を含むはず
    check(fp1.indexOf("same") >= 0, "fingerprint contains message");
    check(fp1 === fp2 || fp1.split("|")[1] === fp2.split("|")[1],
      "messages 部分は同一");

    const e3 = new Error("different");
    const fp3 = fingerprint(e3);
    check(fp1 !== fp3, "different message → different fingerprint");

    console.log("\n[STEP 3] getWindowSeconds は環境変数を反映");
    const original = process.env.ERROR_NOTIFY_WINDOW_SECONDS;
    process.env.ERROR_NOTIFY_WINDOW_SECONDS = "60";
    check(getWindowSeconds() === 60, "60秒に上書きできる");
    process.env.ERROR_NOTIFY_WINDOW_SECONDS = "";
    check(getWindowSeconds() === 300, "未設定時は300秒");
    process.env.ERROR_NOTIFY_WINDOW_SECONDS = original || "";

    console.log("\n[STEP 4] notifyError(dryRun=true) は通知＋not suppressed");
    resetCache();
    const r1 = await notifyError(new Error("dryrun-test"), { source: "test" }, { dryRun: true });
    check(r1.ok === true, "dryRun result.ok === true");
    check(r1.suppressed === false, "dryRun → not suppressed");

    console.log("\n[STEP 5] ERROR_NOTIFY_DISABLED=true で全部 suppressed");
    process.env.ERROR_NOTIFY_DISABLED = "true";
    const r2 = await notifyError(new Error("disabled-test"), {}, { dryRun: true });
    check(r2.suppressed === true, "disabled → suppressed");
    check(r2.reason === "disabled", "reason === 'disabled'");
    process.env.ERROR_NOTIFY_DISABLED = "false";

    console.log("\n[STEP 6] 重複抑制（モック sendNotification 使用）");
    resetCache();
    const mock = mockSendNotification();
    try {
      const err = new Error("dup-test-" + Date.now());
      const r3a = await notifyError(err, { source: "test" }); // dryRunではない=record される
      const r3b = await notifyError(err, { source: "test" });
      check(r3a.suppressed === false, "1st: not suppressed");
      check(r3b.suppressed === true, "2nd: suppressed (rate_limited)");
      check(r3b.reason === "rate_limited", "reason === 'rate_limited'");
      check(mock.calls.length === 1, "mock.sendNotification called once",
        "actual=" + mock.calls.length);

      console.log("\n[STEP 7] resetCache でクリア → 再度通知できる");
      resetCache();
      const r3c = await notifyError(err, { source: "test" });
      check(r3c.suppressed === false, "after resetCache: not suppressed");
      check(mock.calls.length === 2, "mock.sendNotification called total 2 times",
        "actual=" + mock.calls.length);

      console.log("\n[STEP 8] payload に title/summary/fields が乗る");
      const lastCall = mock.calls[mock.calls.length - 1];
      check(typeof lastCall.title === "string" && lastCall.title.indexOf("アプリエラー") >= 0,
        "title に '🚨 アプリエラー' を含む");
      check(typeof lastCall.summary === "string" && lastCall.summary.indexOf(err.message) >= 0,
        "summary に message を含む");
      check(lastCall.fields && lastCall.fields.source === "test",
        "fields.source === 'test'");
    } finally {
      mock.restore();
    }

    console.log("\n[STEP 9] 異なる fingerprint なら抑制されない");
    resetCache();
    const mock2 = mockSendNotification();
    try {
      await notifyError(new Error("aaa"));
      await notifyError(new Error("bbb"));
      check(mock2.calls.length === 2, "different fingerprints → both pass through");
    } finally {
      mock2.restore();
    }

    console.log("\n[STEP 10] sendNotification が throw しても fail-safe");
    resetCache();
    const notifyMod = require("../src/notify");
    const original2 = notifyMod.sendNotification;
    notifyMod.sendNotification = async () => { throw new Error("slack down"); };
    const r4 = await notifyError(new Error("triggers-failure"));
    notifyMod.sendNotification = original2;
    check(r4.ok === false, "sendNotification fails → result.ok === false");
    check(typeof r4.error === "string" && r4.error.indexOf("slack down") >= 0,
      "result.error captured");

    console.log("\n=== 結果: " + passed + " passed, " + failed + " failed ===");
  } catch (err) {
    console.error("[test] fatal:", err);
    failed++;
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
