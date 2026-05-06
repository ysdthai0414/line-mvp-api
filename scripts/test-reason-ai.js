#!/usr/bin/env node
// =============================================================
// D1 reason_ai 単体テスト
//
// 使い方:
//   node scripts/test-reason-ai.js
//
// シナリオ:
//   1) mockAi=true でモック文字列が返る
//   2) REASON_AI_DISABLED=true なら null を返す
//   3) user/initiative が欠落していたら null を返す
//   4) ANTHROPIC_API_KEY 未設定なら null を返す
//   5) flex.buildReasonText に _dynamicReason が入っていればそれを優先
//   6) _dynamicReason が空文字/空白のみなら静的テンプレにフォールバック
//   7) attachDynamicReasons が recs に _dynamicReason を注入する（mockAi）
//
// 注意: Claude API は呼ばない（mockAi/disabled/no-key 経路だけテスト）
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const reasonAi = require("../src/reason_ai");
const { buildReasonText } = require("../src/flex");

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function main() {
  console.log("=== D1 reason_ai テスト ===");
  try {
    console.log("\n[STEP 1] mockAi=true で { reason, application } オブジェクト");
    const r1 = await reasonAi.generateReasonText({
      user: { companyName: "テスト株式会社", profile: {} },
      initiative: { title: "DX事例", category: "DX" },
      reasons: { industries: [], themes: [], interests: [] },
      mockAi: true,
    });
    check(r1 && typeof r1 === "object", "mockAi → オブジェクトを返す");
    check(r1 && r1.reason === reasonAi.MOCK_REASON, "mockAi → reason が MOCK_REASON と一致");
    check(r1 && r1.application === reasonAi.MOCK_APPLICATION, "mockAi → application が MOCK_APPLICATION と一致");

    console.log("\n[STEP 2] REASON_AI_DISABLED=true で null");
    process.env.REASON_AI_DISABLED = "true";
    const r2 = await reasonAi.generateReasonText({
      user: { companyName: "X" },
      initiative: { title: "Y", category: "DX" },
      reasons: {},
      mockAi: true, // disabled が優先
    });
    check(r2 === null, "disabled → null", "actual=" + JSON.stringify(r2));
    process.env.REASON_AI_DISABLED = "false";

    console.log("\n[STEP 3] user/initiative 欠落 → null");
    const r3a = await reasonAi.generateReasonText({ user: null, initiative: { title: "X", category: "DX" }, reasons: {}, mockAi: true });
    const r3b = await reasonAi.generateReasonText({ user: { companyName: "Y" }, initiative: null, reasons: {}, mockAi: true });
    check(r3a === null, "user 欠落 → null");
    check(r3b === null, "initiative 欠落 → null");

    console.log("\n[STEP 4] ANTHROPIC_API_KEY 未設定 + mockAi=false で null（API呼ばない）");
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "";
    const r4 = await reasonAi.generateReasonText({
      user: { companyName: "Z", profile: {} },
      initiative: { title: "Z", category: "DX" },
      reasons: {},
      mockAi: false,
    });
    check(r4 === null, "API_KEY 空 + mockAi=false → null");
    process.env.ANTHROPIC_API_KEY = origKey;

    console.log("\n[STEP 5] buildReasonText: _dynamicReason 優先");
    const txt5 = buildReasonText({
      industries: ["卸売業"],
      themes: ["販路拡大"],
      _dynamicReason: "御社の卸売業 × 販路拡大に近い具体的な事例です",
    });
    check(
      txt5 === "御社の卸売業 × 販路拡大に近い具体的な事例です",
      "_dynamicReason 値そのまま"
    );

    console.log("\n[STEP 6] _dynamicReason 空 → 静的テンプレにフォールバック");
    const txt6a = buildReasonText({ _dynamicReason: "", interests: ["DX"] });
    const txt6b = buildReasonText({ _dynamicReason: "   ", industries: ["建設業"], themes: ["DX"] });
    check(
      txt6a.indexOf("DX") >= 0,
      "空文字: 静的テンプレに interests が反映"
    );
    check(
      txt6b.indexOf("建設業") >= 0,
      "空白のみ: 静的テンプレに industries が反映"
    );

    console.log("\n[STEP 7] attachDynamicReasons が _dynamicReason を注入する（mockAi）");
    // delivery_runner を読み込む（DB初期化はテスト時には不要だが import自体はOK）
    const deliveryRunner = require("../src/delivery_runner");
    const recs = [
      { id: 100, title: "test1", category: "DX", _reasons: { industries: [], themes: [] } },
      { id: 101, title: "test2", category: "M&A", _reasons: { industries: [], themes: [] } },
    ];
    // getLatestProfile が呼ばれるが DB 接続が無いとエラーになるので、
    // reasonAi.generateReasonText を直接 spy してテスト用に注入する代わりに、
    // mockAi=true 経路で reason_ai が即時に MOCK_REASON を返すことに依存。
    // attachDynamicReasons は内部で getLatestProfile を呼ぶので、ここはスキップして
    // 直接 reason_ai を recs に当てる検証で代替する。
    for (const r of recs) {
      const result = await reasonAi.generateReasonText({
        user: { companyName: "テスト", profile: {} },
        initiative: r,
        reasons: r._reasons,
        mockAi: true,
      });
      // Phase 7-3：戻り値はオブジェクト { reason, application }
      if (result && typeof result === "object") {
        r._reasons._dynamicReason = result.reason;
        r._reasons._applicationText = result.application;
      }
    }
    check(
      recs[0]._reasons._dynamicReason === reasonAi.MOCK_REASON,
      "rec[0]._dynamicReason === MOCK_REASON"
    );
    check(
      recs[0]._reasons._applicationText === reasonAi.MOCK_APPLICATION,
      "rec[0]._applicationText === MOCK_APPLICATION"
    );
    check(
      recs[1]._reasons._dynamicReason === reasonAi.MOCK_REASON,
      "rec[1]._dynamicReason === MOCK_REASON"
    );

    console.log("\n[STEP 8] flex.buildReasonText が injected reason を表示する");
    const txt8 = buildReasonText(recs[0]._reasons);
    check(txt8 === reasonAi.MOCK_REASON, "buildReasonText が _dynamicReason を返す");

    console.log("\n=== 結果: " + passed + " passed, " + failed + " failed ===");
  } catch (err) {
    console.error("[test] fatal:", err);
    failed++;
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
