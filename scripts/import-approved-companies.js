#!/usr/bin/env node
// 100億宣言企業一覧 (xlsx) を ApprovedCompanies (MySQL) に取り込む
//
// 使い方:
//   node scripts/import-approved-companies.js path/to/sengenkigyoichiran_YYYYMMDD.xlsx
//
// 既存行は corporate_number(法人番号) を一意キーとして INSERT ... ON DUPLICATE KEY UPDATE で upsert する。
// 売上高（億円）→ 円 への変換も行う。

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { normalizeCompanyName } = require("../src/match");
const { getPool } = require("../src/db");

const COLS = {
  no: "No",
  corporate_number: "法人番号",
  application_type: "申請形態",
  company_name: "法人名",
  prefecture: "本社所在地",
  industry_major: "業種（大分類）",
  industry_minor: "業種（中分類）",
  employee_count: "常時使用する従業員（人）",
  annual_sales_oku: "売上高（億円）※",
  target_year: "目標達成予定年",
  declaration_link: "100億宣言リンク",
};

function parseRow(row) {
  const corporateNumber = String(row[COLS.corporate_number] || "").replace(/\s/g, "");
  const companyName = String(row[COLS.company_name] || "").trim();
  if (!corporateNumber || !companyName) return null;

  const sales_oku = row[COLS.annual_sales_oku];
  const annual_sales =
    sales_oku === undefined || sales_oku === null || sales_oku === ""
      ? null
      : Math.round(Number(sales_oku) * 100000000);

  const employee = row[COLS.employee_count];
  const employee_count =
    employee === undefined || employee === null || employee === ""
      ? null
      : parseInt(employee, 10);

  const target = row[COLS.target_year];
  const target_year =
    target === undefined || target === null || target === ""
      ? null
      : parseInt(target, 10);

  return {
    corporate_number: corporateNumber,
    company_name: companyName,
    company_name_normalized: normalizeCompanyName(companyName),
    application_type: row[COLS.application_type] || null,
    prefecture: row[COLS.prefecture] || null,
    industry_major: row[COLS.industry_major] || null,
    industry_minor: row[COLS.industry_minor] || null,
    employee_count,
    annual_sales,
    target_year,
    declaration_pdf_url: row.__declaration_pdf_url || null,
    source_row: JSON.stringify(row),
  };
}

function readSheet(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];

  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  let headerRowIdx = -1;
  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i] || [];
    if (row.includes(COLS.corporate_number) && row.includes(COLS.company_name)) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) {
    throw new Error("ヘッダ行が見つかりません（『法人番号』『法人名』を含む行が必要）");
  }
  const headers = aoa[headerRowIdx];
  const linkColIdx = headers.indexOf(COLS.declaration_link);

  const records = [];
  for (let i = headerRowIdx + 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (!row || row.every((c) => c === null || c === "")) continue;
    const rowObj = {};
    headers.forEach((h, j) => { rowObj[h] = row[j]; });
    if (linkColIdx >= 0) {
      const cellAddr = XLSX.utils.encode_cell({ c: linkColIdx, r: i });
      const cell = ws[cellAddr];
      if (cell && cell.l && cell.l.Target) {
        rowObj.__declaration_pdf_url = cell.l.Target;
      }
    }
    records.push(rowObj);
  }
  return records;
}

async function upsert(pool, rec) {
  await pool.execute(
    "INSERT INTO ApprovedCompanies " +
    "(corporate_number, company_name, company_name_normalized, " +
    " application_type, prefecture, industry_major, industry_minor, " +
    " employee_count, annual_sales, target_year, " +
    " declaration_pdf_url, source_row) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON)) " +
    "ON DUPLICATE KEY UPDATE " +
    "  company_name = VALUES(company_name), " +
    "  company_name_normalized = VALUES(company_name_normalized), " +
    "  application_type = VALUES(application_type), " +
    "  prefecture = VALUES(prefecture), " +
    "  industry_major = VALUES(industry_major), " +
    "  industry_minor = VALUES(industry_minor), " +
    "  employee_count = VALUES(employee_count), " +
    "  annual_sales = VALUES(annual_sales), " +
    "  target_year = VALUES(target_year), " +
    "  declaration_pdf_url = VALUES(declaration_pdf_url), " +
    "  source_row = VALUES(source_row), " +
    "  updated_at = CURRENT_TIMESTAMP(3)",
    [
      rec.corporate_number,
      rec.company_name,
      rec.company_name_normalized,
      rec.application_type,
      rec.prefecture,
      rec.industry_major,
      rec.industry_minor,
      rec.employee_count,
      rec.annual_sales,
      rec.target_year,
      rec.declaration_pdf_url,
      rec.source_row,
    ]
  );
}

async function main() {
  // .env をロード（dotenv ではなく素朴に process.env を参照する想定だが、便利のため対応）
  try { require("dotenv").config(); } catch (_e) { /* dotenv未インストールでも動く */ }

  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/import-approved-companies.js <xlsx>");
    process.exit(1);
  }
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.error("File not found:", abs);
    process.exit(1);
  }
  console.log("[import] reading", abs);

  const rows = readSheet(abs);
  console.log("[import] rows:", rows.length);

  const pool = getPool();
  let ok = 0;
  let skip = 0;
  for (let i = 0; i < rows.length; i++) {
    const rec = parseRow(rows[i]);
    if (!rec) { skip++; continue; }
    try {
      await upsert(pool, rec);
      ok++;
      if (ok % 100 === 0) console.log(`[import] ${ok}/${rows.length}`);
    } catch (e) {
      console.error(`[import] failed row ${i + 1} (${rec.corporate_number}):`, e.message);
      skip++;
    }
  }
  console.log(`[import] done. upserted=${ok}, skipped=${skip}`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[import] fatal:", err);
  process.exit(1);
});
