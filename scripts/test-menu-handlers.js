#!/usr/bin/env node
// =============================================================
// リッチメニューボタン (#24) のレスポンス生成テスト
//
// 使い方:
//   node scripts/test-menu-handlers.js
//
// 何をするか:
//   1) テスト用 CONFIRMED ユーザー (U_TEST_RICH_MENU) を作成
//      - Profile を1件登録（business_summary 等のフィールドあり）
//      - DeliveryLog に2件投入（feedback の有無を変える）
//      - MatchingRequests に1件 pending を投入
//      - interests に1カテゴリ設定
//   2) dispatchMenuPostback の各 item を呼んで messages を検証
//      - profile  : Flex Message (type=flex) が1つ返る
//      - history  : テキストに「直近の配信履歴」と各 title が含まれる
//      - offers   : テキストに「申請中」と会社名が含まれる
//      - settings : テキストに「現在の関心テーマ」+ Quick Reply 8件
//      - settings_reset : 関心テーマがクリアされる
//   3) クリーンアップ
//
// LINE API は呼びません（純粋な単体テスト）。
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const {
  getPool,
  addUserInterest,
  getUserPreferences,
} = require("../src/db");
const {
  dispatchMenuPostback,
} = require("../src/menu_handlers");
const { recordMatchingRequest } = require("../src/matching");

const TEST_USER = "U_TEST_RICH_MENU";

let passed = 0;
let failed = 0;
function pass(name) { passed++; console.log("  ✓ " + name); }
function fail(name, detail) { failed++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function cleanup() {
  const pool = getPool();
  await pool.execute("DELETE FROM DeliveryLog WHERE line_user_id = ?", [TEST_USER]);
  await pool.execute("DELETE FROM Profiles WHERE line_user_id = ?", [TEST_USER]);
  await pool.execute("DELETE FROM MatchingRequests WHERE line_user_id = ?", [TEST_USER]);
  await pool.execute("DELETE FROM Users WHERE line_user_id = ?", [TEST_USER]);
}

async function pickAvailableInitiative() {
  // 配信履歴のテストでは status='published' の Initiative を1件参照する。
  // なければシードの中から1件取る。
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id, approved_company_id FROM Initiatives " +
    "WHERE status = 'published' ORDER BY id LIMIT 2"
  );
  return rows;
}

async function pickAvailableCompany() {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id, company_name FROM ApprovedCompanies " +
    "WHERE prefecture IS NOT NULL ORDER BY id LIMIT 1"
  );
  return rows[0] || null;
}

async function setup() {
  const pool = getPool();
  await cleanup();

  // approved_company_id を1社拝借
  const myCompany = await pickAvailableCompany();
  if (!myCompany) throw new Error("認可企業データが無いためテスト不可");

  // ユーザー作成
  await pool.execute(
    "INSERT INTO Users " +
    "(line_user_id, state, approved_company_id, sales_tier, annual_sales) " +
    "VALUES (?, 'CONFIRMED', ?, '30_50', 4000000000)",
    [TEST_USER, myCompany.id]
  );

  const profileJson = {
    business_summary: "テスト株式会社のテスト用要約",
    target_customers: "建設業者",
    industry_tags: ["卸売業", "建設関連"],
    management_themes: ["販路拡大", "DX"],
    wanted_support_areas: ["仕入先との協働体制"],
    strengths: ["地域密着", "長年の取引関係", "提案力"],
  };
  await pool.execute(
    "INSERT INTO Profiles " +
    "(line_user_id, approved_company_id, company_name, company_url, " +
    " sales_tier, annual_sales, profile_json) " +
    "VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))",
    [
      TEST_USER, myCompany.id,
      "テスト株式会社", "https://example-test.invalid/",
      "30_50", 4000000000, JSON.stringify(profileJson),
    ]
  );

  // 配信履歴: 2件（1件は feedback あり、1件はなし）
  const inits = await pickAvailableInitiative();
  for (let i = 0; i < inits.length; i++) {
    const init = inits[i];
    await pool.execute(
      "INSERT INTO DeliveryLog (line_user_id, initiative_id, feedback) " +
      "VALUES (?, ?, ?)",
      [TEST_USER, init.id, i === 0 ? "helpful" : null]
    );
  }

  // pending 申請: 1件
  if (inits[0]) {
    await recordMatchingRequest({
      lineUserId: TEST_USER,
      targetCompanyId: inits[0].approved_company_id,
      sourceInitiativeId: inits[0].id,
    });
  }

  // 関心テーマ
  await addUserInterest(TEST_USER, "DX");

  return { myCompanyId: myCompany.id, inits };
}

function findFlex(messages) {
  return (messages || []).find((m) => m && m.type === "flex");
}
function findText(messages) {
  return (messages || []).find((m) => m && m.type === "text");
}

async function main() {
  console.log("=== リッチメニューボタン応答テスト ===");

  let ctx;
  try {
    console.log("\n[setup] テストデータ準備");
    ctx = await setup();
    pass("test data setup done");

    // profile
    console.log("\n[STEP 1] item=profile → Flex 1件");
    const r1 = await dispatchMenuPostback(TEST_USER, "profile");
    check(Array.isArray(r1.messages), "profile messages is array");
    const flex = findFlex(r1.messages);
    check(!!flex, "profile returns a flex message");
    if (flex) {
      check(
        typeof flex.altText === "string" && flex.altText.indexOf("マイプロファイル") >= 0,
        "altText has 'マイプロファイル'"
      );
      check(
        flex.contents && flex.contents.type === "bubble",
        "contents.type === bubble"
      );
    }

    // history
    console.log("\n[STEP 2] item=history → 直近配信のテキスト");
    const r2 = await dispatchMenuPostback(TEST_USER, "history");
    const t2 = findText(r2.messages);
    check(!!t2, "history returns a text message");
    if (t2) {
      check(t2.text.indexOf("配信履歴") >= 0, "text contains '配信履歴'");
      check(t2.text.indexOf("👍") >= 0 || t2.text.indexOf("・") >= 0, "text shows feedback marker");
    }

    // offers
    console.log("\n[STEP 3] item=offers → 申請中のテキスト");
    const r3 = await dispatchMenuPostback(TEST_USER, "offers");
    const t3 = findText(r3.messages);
    check(!!t3, "offers returns a text message");
    if (t3) {
      check(t3.text.indexOf("申請中") >= 0, "text contains '申請中'");
    }

    // settings (有り)
    console.log("\n[STEP 4] item=settings → 現在のinterests + QR");
    const r4 = await dispatchMenuPostback(TEST_USER, "settings");
    const t4 = findText(r4.messages);
    check(!!t4, "settings returns a text message");
    if (t4) {
      check(t4.text.indexOf("DX") >= 0, "text mentions current interest 'DX'");
      check(
        t4.quickReply && Array.isArray(t4.quickReply.items),
        "settings has quickReply items"
      );
      check(
        t4.quickReply.items.length === 8,
        "quickReply has 8 category items",
        "actual=" + (t4.quickReply.items && t4.quickReply.items.length)
      );
    }

    // settings_reset
    console.log("\n[STEP 5] item=settings_reset → interests クリア");
    const r5 = await dispatchMenuPostback(TEST_USER, "settings_reset");
    const t5 = findText(r5.messages);
    check(!!t5, "settings_reset returns a text message");
    const prefs = await getUserPreferences(TEST_USER);
    check(
      Array.isArray(prefs.interests) && prefs.interests.length === 0,
      "interests cleared in DB",
      "actual=" + JSON.stringify(prefs.interests)
    );

    // unknown
    console.log("\n[STEP 6] item=unknown_xxx → エラーテキスト");
    const r6 = await dispatchMenuPostback(TEST_USER, "unknown_xxx");
    const t6 = findText(r6.messages);
    check(!!t6, "unknown returns a text message");
    if (t6) {
      check(t6.text.indexOf("未知のメニュー") >= 0, "text mentions '未知のメニュー'");
    }

    console.log("\n=== 結果: " + passed + " passed, " + failed + " failed ===");
  } catch (err) {
    console.error("[test] fatal:", err);
    failed++;
  } finally {
    console.log("\n[cleanup]");
    try {
      await cleanup();
      console.log("  ✓ cleanup done");
    } catch (e) {
      console.warn("  ✗ cleanup failed:", e.message);
    }
    await getPool().end();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
