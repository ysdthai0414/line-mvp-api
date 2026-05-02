#!/usr/bin/env node
// 月1配信実行スクリプト
//
// 使い方:
//   node scripts/run-delivery.js                 # 全 CONFIRMED ユーザーへ配信
//   node scripts/run-delivery.js --dry-run       # 送らずにログだけ
//   node scripts/run-delivery.js --user-id Uxxx  # 特定ユーザーのみ
//   node scripts/run-delivery.js --limit 3       # 推薦件数（デフォルト3）
//
// 注意:
//  - LINE Push API 制限を考慮して逐次実行（500ms間隔）
//  - 送信成功時のみ DeliveryLog に記録
//  - DeliveryLog にあるユーザー×Initiative ペアは自動で除外される（recommend.js 側）

try { require("dotenv").config(); } catch (_e) {}

const { messagingApi } = require("@line/bot-sdk");
const { getPool } = require("../src/db");
const { recommendForUser } = require("../src/recommend");
const { buildDeliveryCarouselFlex } = require("../src/flex");

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

async function listTargetUsers(args) {
  const pool = getPool();
  if (args.userId) {
    const [rows] = await pool.execute(
      "SELECT line_user_id FROM Users WHERE line_user_id = ? AND state = 'CONFIRMED'",
      [args.userId]
    );
    return rows.map((r) => r.line_user_id);
  }
  const [rows] = await pool.execute(
    "SELECT line_user_id FROM Users WHERE state = 'CONFIRMED' ORDER BY created_at"
  );
  return rows.map((r) => r.line_user_id);
}

async function recordDelivery(lineUserId, initiativeIds) {
  if (initiativeIds.length === 0) return;
  const pool = getPool();
  const placeholders = initiativeIds.map(() => "(?, ?)").join(", ");
  const flat = [];
  for (const id of initiativeIds) {
    flat.push(lineUserId, id);
  }
  // INSERT IGNORE 相当（重複したらスキップ）
  await pool.execute(
    "INSERT IGNORE INTO DeliveryLog (line_user_id, initiative_id) VALUES " +
      placeholders,
    flat
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);

  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN && !args.dryRun) {
    console.error(
      "[delivery] LINE_CHANNEL_ACCESS_TOKEN が未設定。--dry-run 以外は実行できません。"
    );
    process.exit(1);
  }

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "dummy",
  });

  console.log(
    "[delivery] mode=" +
      (args.dryRun ? "DRY-RUN" : "LIVE") +
      ", userId=" +
      (args.userId || "ALL") +
      ", limit=" +
      args.limit
  );

  const userIds = await listTargetUsers(args);
  console.log("[delivery] target users: " + userIds.length);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const uid of userIds) {
    try {
      const recs = await recommendForUser(uid, args.limit);
      if (recs.length === 0) {
        console.log("  - " + uid + ": no recommendations, skip");
        skipped++;
        continue;
      }
      const titles = recs.map((r) => r.title).join(" / ");
      console.log(
        "  - " + uid + ": " + recs.length + " items → " + titles
      );

      if (args.dryRun) {
        skipped++;
        continue;
      }

      const flex = buildDeliveryCarouselFlex(recs);
      await client.pushMessage({ to: uid, messages: [flex] });
      await recordDelivery(
        uid,
        recs.map((r) => r.id)
      );
      sent++;
      // LINE API 連続送信を抑える
      await sleep(500);
    } catch (err) {
      console.error("  - " + uid + ": failed:", err.message);
      failed++;
    }
  }

  console.log(
    "[delivery] done. sent=" +
      sent +
      ", skipped=" +
      skipped +
      ", failed=" +
      failed
  );
  await getPool().end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[delivery] fatal:", err);
  process.exit(1);
});
