#!/usr/bin/env node
// 任意の .sql ファイルを Azure MySQL に流すユーティリティ。
// mysql クライアント無しでも DDL/DML を投入できる。
//
// 使い方:
//   node scripts/run-sql.js db/schema_v2.sql
//   node scripts/run-sql.js db/seed_initiatives.sql
//   node scripts/run-sql.js db/schema_v2.sql db/seed_initiatives.sql
//
// 注意:
//  - .env から MYSQL_* を読む（src/db.js と同じ作法）
//  - multipleStatements=true で繋ぐので、複数の ; を含むSQLでも一度に流せる
//  - 末尾の SELECT 結果は console.table で表示

try { require("dotenv").config(); } catch (_e) {}

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const sslEnabled = (process.env.MYSQL_SSL || "true") === "true";
const sslRejectUnauthorized =
  (process.env.MYSQL_SSL_REJECT_UNAUTHORIZED || "false") === "true";

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error(
      "Usage: node scripts/run-sql.js <file.sql> [<file.sql> ...]"
    );
    process.exit(1);
  }

  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error("[run-sql] file not found: " + f);
      process.exit(1);
    }
  }

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || "3306", 10),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    ssl: sslEnabled
      ? { minVersion: "TLSv1.2", rejectUnauthorized: sslRejectUnauthorized }
      : undefined,
    multipleStatements: true,
  });

  console.log(
    "[run-sql] connected to " +
      process.env.MYSQL_HOST +
      "/" +
      process.env.MYSQL_DATABASE
  );

  try {
    for (const f of files) {
      // UTF-8 BOM (﻿) を剥がす（PowerShell の Out-File -Encoding utf8 等で混入する）
      const sql = fs.readFileSync(f, "utf8").replace(/^﻿/, "");
      console.log("\n=== " + f + " ===");
      const [results] = await conn.query(sql);
      // 単文SELECTのとき results は行の配列、複文のとき配列の配列になる。
      // 行の配列(=要素がオブジェクト) は単文として1階層に包む。
      const isMultiStatement =
        Array.isArray(results) &&
        results.length > 0 &&
        Array.isArray(results[0]);
      const arr = isMultiStatement ? results : [results];
      for (const r of arr) {
        if (Array.isArray(r) && r.length > 0 && typeof r[0] === "object") {
          console.table(r);
        }
      }
      console.log("OK: " + path.basename(f));
    }
  } catch (err) {
    console.error("[run-sql] failed:", err.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main();
