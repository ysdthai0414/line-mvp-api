#!/usr/bin/env node
// =============================================================
// 100億宣言PDFから取り組み事例(Initiatives)を AI で抽出するバッチ
//
// 使い方:
//   # レベル1: PDF取得+テキスト抽出だけ確認（Claude呼ばずDB書かず）
//   node scripts/import-initiatives.js --company-id 154 --dry-run
//
//   # レベル2: モックAIでDB書き込みまで通す（コスト0、Claude呼ばない）
//   node scripts/import-initiatives.js --company-id 154 --mock-ai
//
//   # レベル3: 1社で実Claude呼び出し（〜$0.05）
//   node scripts/import-initiatives.js --company-id 154
//
//   # レベル4: 段階バッチ（吉田さん運用）
//   node scripts/import-initiatives.js --limit 10 --offset 0
//   node scripts/import-initiatives.js --limit 10 --offset 10
//   node scripts/import-initiatives.js --limit 100 --skip-existing
//
// オプション:
//   --company-id N      対象を1社に絞る（ApprovedCompanies.id）
//   --limit N           最大処理件数（デフォルト 1）
//   --offset N          スキップ件数（ApprovedCompanies.id 順）
//   --dry-run           PDF取得+抽出のみ。AIもDBも触らない
//   --mock-ai           Claudeを呼ばず固定JSONを返す。DB書き込みはする
//   --force             既存の ai_generated レコードを上書き更新（既定はスキップ）
//   --skip-existing     既存があればスキップ（既定どおり、明示用）
//
// 注意:
//  - 既存の seed (source='seed') レコードには触らない
//  - 既定では (approved_company_id, source='ai_generated') が既に存在すればスキップ
//  - --force のときだけ UPDATE で上書き
//  - status は draft で保存（事務局レビュー前提）
//  - APIレート制御のため逐次実行 + 小さなsleep
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { getPool, classifySalesTier } = require("../src/db");
const { fetchPdfText } = require("../src/pdf");
const { generateInitiative, MOCK_INITIATIVE } = require("../src/initiative_ai");

function parseArgs(argv) {
  const args = {
    companyId: null,
    limit: 1,
    offset: 0,
    dryRun: false,
    mockAi: false,
    force: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--mock-ai") args.mockAi = true;
    else if (a === "--force") args.force = true;
    else if (a === "--skip-existing") args.force = false;
    else if (a === "--company-id" && next) {
      args.companyId = parseInt(next, 10);
      i++;
    } else if (a.startsWith("--company-id=")) {
      args.companyId = parseInt(a.split("=")[1], 10);
    } else if (a === "--limit" && next) {
      args.limit = parseInt(next, 10) || 1;
      i++;
    } else if (a.startsWith("--limit=")) {
      args.limit = parseInt(a.split("=")[1], 10) || 1;
    } else if (a === "--offset" && next) {
      args.offset = parseInt(next, 10) || 0;
      i++;
    } else if (a.startsWith("--offset=")) {
      args.offset = parseInt(a.split("=")[1], 10) || 0;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listTargetCompanies(args) {
  const pool = getPool();
  if (args.companyId) {
    const [rows] = await pool.execute(
      "SELECT id, company_name, prefecture, annual_sales, declaration_pdf_url " +
      "FROM ApprovedCompanies WHERE id = ?",
      [args.companyId]
    );
    return rows;
  }
  // declaration_pdf_url が入っているものだけが対象
  // 注: mysql2 の execute() は LIMIT/OFFSET のバインドが効かないので整数化して埋め込む
  const safeLimit = Math.max(1, Math.min(10000, parseInt(args.limit, 10) || 1));
  const safeOffset = Math.max(0, parseInt(args.offset, 10) || 0);
  const [rows] = await pool.execute(
    "SELECT id, company_name, prefecture, annual_sales, declaration_pdf_url " +
    "FROM ApprovedCompanies " +
    "WHERE declaration_pdf_url IS NOT NULL AND declaration_pdf_url <> '' " +
    "ORDER BY id LIMIT " + safeLimit + " OFFSET " + safeOffset
  );
  return rows;
}

async function getExistingAiInitiative(companyId) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id, status FROM Initiatives " +
    "WHERE approved_company_id = ? AND source = 'ai_generated' LIMIT 1",
    [companyId]
  );
  return rows[0] || null;
}

async function upsertInitiative(companyId, data, existingId) {
  const pool = getPool();
  const params = [
    data.title,
    data.summary,
    data.category,
    JSON.stringify(data.industry_tags || []),
    JSON.stringify(data.target_themes || []),
    JSON.stringify(data.bullet_points || []),
  ];
  if (existingId) {
    await pool.execute(
      "UPDATE Initiatives SET " +
      "  title = ?, summary = ?, category = ?, " +
      "  industry_tags = CAST(? AS JSON), target_themes = CAST(? AS JSON), " +
      "  bullet_points = CAST(? AS JSON), " +
      "  updated_at = CURRENT_TIMESTAMP(3) " +
      "WHERE id = ?",
      [...params, existingId]
    );
    return { mode: "update", id: existingId };
  }
  const [result] = await pool.execute(
    "INSERT INTO Initiatives " +
    "  (approved_company_id, title, summary, category, " +
    "   industry_tags, target_themes, bullet_points, " +
    "   status, source) " +
    "VALUES (?, ?, ?, ?, " +
    "        CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), " +
    "        'draft', 'ai_generated')",
    [companyId, ...params]
  );
  return { mode: "insert", id: result.insertId };
}

async function processOne(company, args) {
  const tier = classifySalesTier(company.annual_sales);
  const ctx = {
    companyId: company.id,
    companyName: company.company_name,
    prefecture: company.prefecture,
    salesTier: tier,
    pdfUrl: company.declaration_pdf_url,
  };

  console.log(
    "\n--- [" + ctx.companyId + "] " + ctx.companyName +
      " (" + (ctx.prefecture || "?") + " / " + (tier || "?") + ") ---"
  );
  console.log("  pdf: " + ctx.pdfUrl);

  // 既存スキップ
  if (!args.force) {
    const existing = await getExistingAiInitiative(ctx.companyId);
    if (existing) {
      console.log(
        "  → skip: ai_generated initiative already exists (id=" +
          existing.id + ", status=" + existing.status + "). Use --force to overwrite."
      );
      return { status: "skipped" };
    }
  }

  // PDF取得
  const pdfRes = await fetchPdfText(ctx.pdfUrl);
  if (!pdfRes.ok) {
    console.warn("  ✗ PDF fetch failed:", pdfRes.reason);
    return { status: "pdf_failed", reason: pdfRes.reason };
  }
  console.log(
    "  ✓ PDF fetched: " +
      pdfRes.byteLength + " bytes, " +
      (pdfRes.pageCount || "?") + " pages, " +
      pdfRes.text.length + " chars text"
  );

  if (args.dryRun) {
    console.log("  text head:", pdfRes.text.slice(0, 200));
    console.log("  → dry-run: skip AI and DB");
    return { status: "dry_run" };
  }

  // AI抽出
  let initData;
  try {
    initData = await generateInitiative({
      companyName: ctx.companyName,
      salesTier: tier,
      prefecture: ctx.prefecture,
      pdfText: pdfRes.text,
      mockAi: args.mockAi,
    });
  } catch (err) {
    console.warn("  ✗ AI extraction failed:", err.message);
    return { status: "ai_failed", reason: err.message };
  }
  console.log("  ✓ AI extracted: title=「" + initData.title + "」 category=" + initData.category);

  // DB UPSERT
  const existing = await getExistingAiInitiative(ctx.companyId);
  const result = await upsertInitiative(ctx.companyId, initData, existing && existing.id);
  console.log("  ✓ DB " + result.mode + ": Initiative id=" + result.id + " (status=draft)");

  return { status: "ok", mode: result.mode, initiativeId: result.id };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log("[import-initiatives] mode=" +
    (args.dryRun ? "DRY-RUN" : args.mockAi ? "MOCK-AI" : "LIVE") +
    ", companyId=" + (args.companyId || "—") +
    ", limit=" + args.limit +
    ", offset=" + args.offset +
    ", force=" + args.force);

  if (!args.dryRun && !args.mockAi && !process.env.ANTHROPIC_API_KEY) {
    console.error("[import-initiatives] ANTHROPIC_API_KEY 未設定。" +
      "--dry-run か --mock-ai 以外は実行不可。");
    process.exit(1);
  }

  const companies = await listTargetCompanies(args);
  if (companies.length === 0) {
    console.log("[import-initiatives] 対象企業0件。終了します。");
    await getPool().end();
    process.exit(0);
  }
  console.log("[import-initiatives] 対象企業: " + companies.length + "社");

  const counts = { ok_insert: 0, ok_update: 0, skipped: 0, pdf_failed: 0, ai_failed: 0, dry_run: 0 };
  for (const c of companies) {
    try {
      const r = await processOne(c, args);
      if (r.status === "ok" && r.mode === "insert") counts.ok_insert++;
      else if (r.status === "ok" && r.mode === "update") counts.ok_update++;
      else if (r.status === "skipped") counts.skipped++;
      else if (r.status === "pdf_failed") counts.pdf_failed++;
      else if (r.status === "ai_failed") counts.ai_failed++;
      else if (r.status === "dry_run") counts.dry_run++;
    } catch (err) {
      console.error("  fatal in processOne:", err);
      counts.ai_failed++;
    }
    // APIレート抑制（mock/dry-runでは不要だが副作用ないので統一）
    if (!args.dryRun) await sleep(800);
  }

  console.log("\n=== 集計 ===");
  console.log("  insert:     " + counts.ok_insert);
  console.log("  update:     " + counts.ok_update);
  console.log("  skipped:    " + counts.skipped);
  console.log("  dry_run:    " + counts.dry_run);
  console.log("  pdf_failed: " + counts.pdf_failed);
  console.log("  ai_failed:  " + counts.ai_failed);

  await getPool().end();
  process.exit(counts.pdf_failed + counts.ai_failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[import-initiatives] fatal:", err);
  process.exit(1);
});
