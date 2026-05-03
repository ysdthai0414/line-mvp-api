#!/usr/bin/env node
// =============================================================
// B3 LIFF 配信履歴 単体テスト
//
// 使い方:
//   node scripts/test-liff-history.js
//
// シナリオ:
//   1) liffAuthMiddleware が Bearer 無しの時 401
//   2) Bearer 空文字で 401
//   3) LIFF_CHANNEL_ID 未設定 + 通常 token で 503
//   4) Bearer dev-mock かつ LIFF_DEV_MOCK_USER_ID 未設定で 503
//   5) Bearer dev-mock かつ LIFF_DEV_MOCK_USER_ID 設定で req.lineUserId にセット → next 呼ばれる
//   6) verifyIdToken は idToken 空で throw
//   7) verifyIdToken は LIFF_CHANNEL_ID 未設定で throw
//
// LINE verify API は呼ばない（ネットワーク不要）。
// dev-mock とエラー経路だけで認証ミドルウェアを十分にカバーする。
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const liffAuth = require("../src/liff_auth");
const { liffAuthMiddleware, verifyIdToken } = liffAuth;

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

// 簡易な req/res モック
function makeReq(headers) {
  return {
    headers: headers || {},
    get(key) {
      const v = (this.headers || {})[key.toLowerCase()];
      if (v != null) return v;
      // case-insensitive
      for (const k of Object.keys(this.headers || {})) {
        if (k.toLowerCase() === key.toLowerCase()) return this.headers[k];
      }
      return undefined;
    },
  };
}
function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

async function runMiddleware(headers) {
  const req = makeReq(headers);
  const res = makeRes();
  let nextCalled = false;
  await liffAuthMiddleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

async function main() {
  console.log("=== B3 LIFF auth テスト ===");
  // 環境変数のスナップショット
  const orig = {
    channelId: process.env.LIFF_CHANNEL_ID,
    mockUserId: process.env.LIFF_DEV_MOCK_USER_ID,
  };

  try {
    console.log("\n[STEP 1] Bearer 無しで 401");
    {
      const { res, nextCalled } = await runMiddleware({});
      check(res.statusCode === 401, "401 returned");
      check(!nextCalled, "next not called");
      check(res.body && res.body.ok === false, "body.ok === false");
    }

    console.log("\n[STEP 2] Bearer 空文字で 401");
    {
      const { res, nextCalled } = await runMiddleware({ authorization: "Bearer " });
      check(res.statusCode === 401, "401 returned");
      check(!nextCalled, "next not called");
      // body.error が "empty Bearer token" を含むはず
      check(
        res.body && typeof res.body.error === "string" && res.body.error.indexOf("empty") >= 0,
        "error mentions empty"
      );
    }

    console.log("\n[STEP 3] LIFF_CHANNEL_ID 未設定 + 通常 token で 503");
    {
      process.env.LIFF_CHANNEL_ID = "";
      process.env.LIFF_DEV_MOCK_USER_ID = "";
      const { res, nextCalled } = await runMiddleware({
        authorization: "Bearer some-real-id-token-or-anything",
      });
      check(res.statusCode === 503, "503 returned");
      check(!nextCalled, "next not called");
      check(
        res.body && typeof res.body.error === "string" &&
        res.body.error.indexOf("LIFF_CHANNEL_ID") >= 0,
        "error mentions LIFF_CHANNEL_ID"
      );
    }

    console.log("\n[STEP 4] Bearer dev-mock + MOCK_USER_ID 未設定 → 503");
    {
      process.env.LIFF_CHANNEL_ID = ""; // 関係ない
      process.env.LIFF_DEV_MOCK_USER_ID = "";
      const { res, nextCalled } = await runMiddleware({
        authorization: "Bearer dev-mock",
      });
      check(res.statusCode === 503, "503 returned");
      check(!nextCalled, "next not called");
      check(
        res.body && typeof res.body.error === "string" &&
        res.body.error.indexOf("LIFF_DEV_MOCK_USER_ID") >= 0,
        "error mentions LIFF_DEV_MOCK_USER_ID"
      );
    }

    console.log("\n[STEP 5] Bearer dev-mock + MOCK_USER_ID 設定 → next + req.lineUserId");
    {
      process.env.LIFF_CHANNEL_ID = "";
      process.env.LIFF_DEV_MOCK_USER_ID = "U_DEV_TEST_LIFF";
      const { req, res, nextCalled } = await runMiddleware({
        authorization: "Bearer dev-mock",
      });
      check(nextCalled, "next called");
      check(res.statusCode === 200, "status not changed (200)");
      check(req.lineUserId === "U_DEV_TEST_LIFF", "req.lineUserId === 'U_DEV_TEST_LIFF'");
    }

    console.log("\n[STEP 6] verifyIdToken: idToken 空で throw");
    {
      let threw = false;
      try { await verifyIdToken("", "12345"); } catch (_e) { threw = true; }
      check(threw, "throws on empty idToken");
    }

    console.log("\n[STEP 7] verifyIdToken: channelId 未指定 & 環境変数空で throw");
    {
      process.env.LIFF_CHANNEL_ID = "";
      let threw = false;
      try { await verifyIdToken("dummy-token-xxx"); } catch (_e) { threw = true; }
      check(threw, "throws when channelId not set");
    }

    console.log("\n[STEP 8] case-insensitive header 取り扱い");
    {
      process.env.LIFF_DEV_MOCK_USER_ID = "U_HEADER_TEST";
      // 'Authorization' (capitalized) も認識されるか
      const { req, nextCalled } = await runMiddleware({
        Authorization: "Bearer dev-mock",
      });
      check(nextCalled, "uppercased header → next called");
      check(req.lineUserId === "U_HEADER_TEST", "lineUserId set");
    }

    console.log("\n=== 結果: " + passed + " passed, " + failed + " failed ===");
  } catch (err) {
    console.error("[test] fatal:", err);
    failed++;
  } finally {
    process.env.LIFF_CHANNEL_ID = orig.channelId || "";
    process.env.LIFF_DEV_MOCK_USER_ID = orig.mockUserId || "";
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
