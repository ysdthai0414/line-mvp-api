#!/usr/bin/env node
// =============================================================
// 相談会のリマインド + アーカイブ配信バッチ (Phase 3b-3)
//
// 使い方:
//   # 両方（リマインド + アーカイブ）を回す
//   node scripts/run-consultation-reminders.js --mode both
//
//   # リマインドだけ。NOW から 24 時間以内の confirmed/recruiting イベントが対象
//   node scripts/run-consultation-reminders.js --mode reminder --hours-ahead 24
//
//   # アーカイブだけ。held + archive_url 設定済み が対象
//   node scripts/run-consultation-reminders.js --mode archive
//
//   # 特定イベントだけ
//   node scripts/run-consultation-reminders.js --mode both --event-id 1
//
//   # 試走（送らずに対象抽出だけ）
//   node scripts/run-consultation-reminders.js --mode both --dry-run
//
// 仕様:
//   - 各 participant につき1度だけ送る（reminded_at / archive_pushed_at で冪等）
//   - 送信失敗時はタイムスタンプを更新しないので、再実行で再送可能
//   - LINE Push レート制限を考慮し 500ms 間隔
//   - cron想定: 毎時 1回程度回せば、24時間以内の予定にあるイベントを必ず捕捉できる
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { messagingApi } = require("@line/bot-sdk");
const { getPool } = require("../src/db");
const {
  getEvent,
  findUpcomingEventsNeedingReminder,
  findHeldEventsNeedingArchivePush,
  getJoinedNotReminded,
  markReminded,
  getJoinedNotArchivePushed,
  markArchivePushed,
} = require("../src/consultation");
const {
  buildConsultationReminderFlex,
  buildConsultationArchiveFlex,
} = require("../src/flex");

function parseArgs(argv) {
  const args = {
    mode: "both",
    eventId: null,
    hoursAhead: 24,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--mode" && next) {
      args.mode = next;
      i++;
    } else if (a.startsWith("--mode=")) {
      args.mode = a.split("=")[1];
    } else if (a === "--event-id" && next) {
      args.eventId = parseInt(next, 10);
      i++;
    } else if (a.startsWith("--event-id=")) {
      args.eventId = parseInt(a.split("=")[1], 10);
    } else if (a === "--hours-ahead" && next) {
      args.hoursAhead = parseInt(next, 10) || 24;
      i++;
    } else if (a.startsWith("--hours-ahead=")) {
      args.hoursAhead = parseInt(a.split("=")[1], 10) || 24;
    }
  }
  if (!["both", "reminder", "archive"].includes(args.mode)) {
    throw new Error("--mode は both | reminder | archive のいずれか");
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pushFlex(client, lineUserId, flex) {
  await client.pushMessage({ to: lineUserId, messages: [flex] });
}

/**
 * 1イベント分のリマインドを実行。
 * 戻り値: { sent, failed, skipped }
 */
async function runReminderForEvent(client, ev, args) {
  const targets = await getJoinedNotReminded(ev.id);
  if (targets.length === 0) return { sent: 0, failed: 0, skipped: 0 };

  console.log(
    "  [reminder] event=" + ev.id + " 「" + ev.title +
    "」 → 対象 " + targets.length + " 名"
  );

  if (args.dryRun) {
    return { sent: 0, failed: 0, skipped: targets.length };
  }

  const flex = buildConsultationReminderFlex(ev);
  let sent = 0, failed = 0;
  for (const t of targets) {
    try {
      await pushFlex(client, t.line_user_id, flex);
      await markReminded(ev.id, t.line_user_id);
      sent++;
      await sleep(500);
    } catch (err) {
      failed++;
      console.error("    ✗ reminder push failed for " + t.line_user_id + ":", err.message || err);
    }
  }
  return { sent, failed, skipped: 0 };
}

/**
 * 1イベント分のアーカイブ配信を実行。
 */
async function runArchiveForEvent(client, ev, args) {
  if (!ev.archive_url) {
    console.log(
      "  [archive] event=" + ev.id + " skip: archive_url 未設定"
    );
    return { sent: 0, failed: 0, skipped: 0 };
  }
  const targets = await getJoinedNotArchivePushed(ev.id);
  if (targets.length === 0) return { sent: 0, failed: 0, skipped: 0 };

  console.log(
    "  [archive] event=" + ev.id + " 「" + ev.title +
    "」 → 対象 " + targets.length + " 名"
  );

  if (args.dryRun) {
    return { sent: 0, failed: 0, skipped: targets.length };
  }

  const flex = buildConsultationArchiveFlex(ev);
  let sent = 0, failed = 0;
  for (const t of targets) {
    try {
      await pushFlex(client, t.line_user_id, flex);
      await markArchivePushed(ev.id, t.line_user_id);
      sent++;
      await sleep(500);
    } catch (err) {
      failed++;
      console.error("    ✗ archive push failed for " + t.line_user_id + ":", err.message || err);
    }
  }
  return { sent, failed, skipped: 0 };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(
    "[reminders] mode=" + args.mode +
    ", eventId=" + (args.eventId || "(auto)") +
    ", hoursAhead=" + args.hoursAhead +
    ", dryRun=" + args.dryRun
  );

  if (!args.dryRun && !process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("LINE_CHANNEL_ACCESS_TOKEN 未設定。--dry-run 以外は実行不可。");
    process.exit(1);
  }

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "dummy",
  });

  const totals = { sent: 0, failed: 0, skipped: 0 };
  const tally = (r) => {
    totals.sent += r.sent;
    totals.failed += r.failed;
    totals.skipped += r.skipped;
  };

  // ---- リマインド ----
  if (args.mode === "both" || args.mode === "reminder") {
    let events;
    if (args.eventId) {
      const e = await getEvent(args.eventId);
      events = e ? [e] : [];
    } else {
      events = await findUpcomingEventsNeedingReminder(args.hoursAhead);
    }
    console.log("[reminder] 対象イベント: " + events.length + "件");
    for (const ev of events) {
      tally(await runReminderForEvent(client, ev, args));
    }
  }

  // ---- アーカイブ ----
  if (args.mode === "both" || args.mode === "archive") {
    let events;
    if (args.eventId) {
      const e = await getEvent(args.eventId);
      events = e && e.status === "held" && e.archive_url ? [e] : [];
      if (e && (e.status !== "held" || !e.archive_url)) {
        console.log(
          "[archive] event " + e.id + " は held + archive_url 未満たすためスキップ"
        );
      }
    } else {
      events = await findHeldEventsNeedingArchivePush();
    }
    console.log("[archive] 対象イベント: " + events.length + "件");
    for (const ev of events) {
      tally(await runArchiveForEvent(client, ev, args));
    }
  }

  console.log("\n=== 集計 ===");
  console.log("  sent:    " + totals.sent);
  console.log("  failed:  " + totals.failed);
  console.log("  skipped: " + totals.skipped + (args.dryRun ? " (dry-run)" : ""));

  await getPool().end();
  process.exit(totals.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[reminders] fatal:", err);
  process.exit(1);
});
