#!/usr/bin/env node
// =============================================================
// 相談会の参加打診 push バッチ (Phase 3b-2)
//
// 使い方:
//   # 通常実行：invited で pushed_at が NULL の参加者へ Flex を push
//   node scripts/push-consultation-invites.js --event-id 1
//
//   # 通知ペイロードだけ確認、push しない
//   node scripts/push-consultation-invites.js --event-id 1 --dry-run
//
//   # 既に push 済みでも再送（pushed_at をクリアしてから再 push）
//   node scripts/push-consultation-invites.js --event-id 1 --force
//
// 注意:
//   - LINE Push API のレート制限を考慮して 500ms 間隔で逐次送信
//   - status='invited' のユーザーが対象。joined/declined は対象外
//   - イベント status が 'cancelled' の場合は中止メッセージとして別途送ってもよいが、本スクリプトは pure な参加打診のみ
//   - 失敗時は pushed_at を更新しないので、再実行で再送可能
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { messagingApi } = require("@line/bot-sdk");
const { getPool } = require("../src/db");
const {
  getEvent,
  getInvitedNotPushed,
  markPushed,
  clearPushedAt,
} = require("../src/consultation");
const { buildConsultationInviteFlex } = require("../src/flex");

function parseArgs(argv) {
  const args = { eventId: null, dryRun: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--event-id" && next) {
      args.eventId = parseInt(next, 10);
      i++;
    } else if (a.startsWith("--event-id=")) {
      args.eventId = parseInt(a.split("=")[1], 10);
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.eventId) {
    console.error("--event-id <id> は必須です");
    process.exit(1);
  }
  if (!args.dryRun && !process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error(
      "LINE_CHANNEL_ACCESS_TOKEN が未設定。--dry-run 以外は実行不可。"
    );
    process.exit(1);
  }

  console.log(
    "[push-invites] mode=" +
      (args.dryRun ? "DRY-RUN" : "LIVE") +
      ", eventId=" + args.eventId +
      ", force=" + args.force
  );

  const ev = await getEvent(args.eventId);
  if (!ev) {
    console.error("ConsultationEvent id=" + args.eventId + " が見つかりません");
    await getPool().end();
    process.exit(1);
  }
  console.log(
    "  event: [" + ev.id + "] " + (ev.host_company_name || "—") +
    " / 「" + ev.title + "」 / status=" + ev.status
  );

  if (ev.status === "cancelled" || ev.status === "held") {
    console.warn(
      "  ⚠ event status=" + ev.status +
      " のため打診の対象として通常は不適切です（強制実行する場合は注意）"
    );
  }

  if (args.force) {
    console.log("  force=true → 当該 event の pushed_at を全クリア");
    if (!args.dryRun) await clearPushedAt(args.eventId);
  }

  const targets = await getInvitedNotPushed(args.eventId);
  console.log("  対象participants: " + targets.length + " 名");

  if (targets.length === 0) {
    console.log("  → 対象なし。終了します。");
    await getPool().end();
    process.exit(0);
  }

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "dummy",
  });
  const flex = buildConsultationInviteFlex(ev);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const t of targets) {
    console.log("  → " + t.line_user_id);
    if (args.dryRun) {
      skipped++;
      continue;
    }
    try {
      await client.pushMessage({ to: t.line_user_id, messages: [flex] });
      await markPushed(args.eventId, t.line_user_id);
      sent++;
      await sleep(500);
    } catch (err) {
      failed++;
      console.error("    ✗ push failed:", err.message || err);
      // pushed_at は更新しない（再実行で再送できるよう）
    }
  }

  console.log("\n=== 集計 ===");
  console.log("  sent:    " + sent);
  console.log("  skipped: " + skipped + (args.dryRun ? " (dry-run)" : ""));
  console.log("  failed:  " + failed);

  if (args.dryRun) {
    console.log("\nFlex altText: " + flex.altText);
  }

  await getPool().end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[push-invites] fatal:", err);
  process.exit(1);
});
