#!/usr/bin/env node
// 月1（または週1）配信実行スクリプト（CLI ラッパ）
//
// 使い方:
//   node scripts/run-delivery.js                 # 全 CONFIRMED ユーザーへ配信
//   node scripts/run-delivery.js --dry-run       # 送らずにログだけ
//   node scripts/run-delivery.js --user-id Uxxx  # 特定ユーザーのみ
//   node scripts/run-delivery.js --limit 3       # 推薦件数（デフォルト3）
//
// コアロジックは src/delivery_runner.js に切り出した（HTTPからも呼ばれる）。
// 本ファイルは CLI 引数のパースと終了コード判定だけを担う薄いラッパ。

try { require("dotenv").config(); } catch (_e) {}

const { getPool } = require("../src/db");
const { runDelivery } = require("../src/delivery_runner");

function parseArgs(argv) {
  const args = { dryRun: false, userId: null, limit: 3 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--user-id" && argv[i + 1]) {
      args.userId = argv[++i];
    } else if (a.startsWith("--user-id=")) {
      args.userId = a.split("=")[1];
    } else if (a === "--limit" && argv[i + 1]) {
      args.limit = parseInt(argv[++i], 10) || 3;
    } else if (a.startsWith("--limit=")) {
      args.limit = parseInt(a.split("=")[1], 10) || 3;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runDelivery({
    userId: args.userId,
    limit: args.limit,
    dryRun: args.dryRun,
  });

  await getPool().end();
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[delivery] fatal:", err);
  process.exit(1);
});
