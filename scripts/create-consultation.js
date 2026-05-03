#!/usr/bin/env node
// =============================================================
// 事務局向け 相談会管理 CLI (Phase 3b-1)
//
// 使い方（サブコマンド方式）:
//   node scripts/create-consultation.js list [--status held]
//   node scripts/create-consultation.js show <eventId>
//   node scripts/create-consultation.js create \
//        --company-id 154 \
//        --title "株式会社大和 経営者勉強会" \
//        --datetime "2026-06-15 19:00" \
//        --duration 60 \
//        --zoom-url "https://zoom.us/..." \
//        --capacity 10 \
//        --description "100億宣言企業の経営者を招いた相談会"
//   node scripts/create-consultation.js invite <eventId> --company-id 154
//   node scripts/create-consultation.js status <eventId> recruiting
//   node scripts/create-consultation.js participants <eventId>
//   node scripts/create-consultation.js set-participant <eventId> <lineUserId> joined
//
// イベントステータス:  planned | recruiting | confirmed | held | cancelled
// 参加者ステータス:    invited | joined | declined | attended | absent | cancelled
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { getPool } = require("../src/db");
const {
  createEvent,
  getEvent,
  listEvents,
  updateEventStatus,
  getParticipants,
  setParticipantStatus,
  inviteParticipantsFromMatchingRequests,
  VALID_EVENT_STATUSES,
  VALID_PARTICIPANT_STATUSES,
} = require("../src/consultation");

function parseFlags(argv, startIdx) {
  const flags = {};
  for (let i = startIdx; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function fmtDate(v) {
  if (!v) return "—";
  try { return new Date(v).toISOString(); }
  catch (_e) { return String(v); }
}

async function cmdList(argv) {
  const flags = parseFlags(argv, 3);
  const events = await listEvents({
    status: flags.status,
    hostCompanyId: flags["company-id"] ? parseInt(flags["company-id"], 10) : null,
    limit: flags.limit ? parseInt(flags.limit, 10) : 50,
  });
  if (events.length === 0) {
    console.log("(該当する相談会はありません)");
    return;
  }
  console.log("=== 相談会 一覧 (" + events.length + "件) ===");
  for (const e of events) {
    console.log(
      "  [" + e.id + "] " + e.status.padEnd(11) +
      "  " + fmtDate(e.scheduled_at) +
      "  " + (e.host_company_name || "—") +
      "  | 「" + e.title + "」" +
      "  | 参加者=" + e.participant_count +
      (e.capacity > 0 ? "/" + e.capacity : "")
    );
  }
}

async function cmdShow(argv) {
  const eventId = parseInt(argv[3], 10);
  if (!eventId) throw new Error("eventId 必須: show <eventId>");
  const event = await getEvent(eventId);
  if (!event) {
    console.log("(eventId=" + eventId + " の相談会は存在しません)");
    return;
  }
  console.log("=== ConsultationEvent #" + eventId + " ===");
  console.log("  status:           " + event.status);
  console.log("  host:             [" + event.host_approved_company_id + "] " +
    event.host_company_name + " (" + event.host_prefecture + ")");
  console.log("  title:            " + event.title);
  if (event.description) console.log("  description:      " + event.description);
  console.log("  scheduled_at:     " + fmtDate(event.scheduled_at));
  console.log("  duration_minutes: " + event.duration_minutes);
  console.log("  zoom_url:         " + (event.zoom_url || "—"));
  console.log("  capacity:         " + (event.capacity || "(無制限)"));
  console.log("  participant_counts:");
  for (const s of VALID_PARTICIPANT_STATUSES) {
    const n = event.participant_counts[s] || 0;
    if (n > 0) console.log("    " + s.padEnd(10) + ": " + n);
  }
  if (event.archive_url) console.log("  archive_url:      " + event.archive_url);
  console.log("  created_at:       " + fmtDate(event.created_at));
  console.log("  updated_at:       " + fmtDate(event.updated_at));
}

async function cmdCreate(argv) {
  const flags = parseFlags(argv, 3);
  const required = ["company-id", "title", "datetime"];
  for (const k of required) {
    if (!flags[k]) throw new Error("--" + k + " は必須です");
  }
  const id = await createEvent({
    hostCompanyId: parseInt(flags["company-id"], 10),
    title: flags.title,
    description: flags.description || null,
    scheduledAt: flags.datetime,
    durationMinutes: flags.duration ? parseInt(flags.duration, 10) : 60,
    zoomUrl: flags["zoom-url"] || null,
    capacity: flags.capacity ? parseInt(flags.capacity, 10) : 0,
    status: flags.status || "planned",
  });
  console.log("✓ created ConsultationEvent id=" + id);
  await cmdShow(["", "", "show", String(id)]);
}

async function cmdInvite(argv) {
  const eventId = parseInt(argv[3], 10);
  if (!eventId) throw new Error("eventId 必須: invite <eventId> --company-id N");
  const flags = parseFlags(argv, 4);
  const companyId = flags["company-id"]
    ? parseInt(flags["company-id"], 10)
    : null;
  if (!companyId) {
    // event の host_company_id をデフォルトに
    const ev = await getEvent(eventId);
    if (!ev) throw new Error("eventId=" + eventId + " の相談会は存在しません");
    console.log("(--company-id 省略のため host_approved_company_id=" +
      ev.host_approved_company_id + " を使用)");
    const r = await inviteParticipantsFromMatchingRequests(
      eventId, ev.host_approved_company_id
    );
    console.log("✓ invited=" + r.invited + " (totalPending=" + r.totalPending + ")");
    return;
  }
  const r = await inviteParticipantsFromMatchingRequests(eventId, companyId);
  console.log("✓ invited=" + r.invited + " (totalPending=" + r.totalPending + ")");
}

async function cmdStatus(argv) {
  const eventId = parseInt(argv[3], 10);
  const status = argv[4];
  if (!eventId || !status) {
    throw new Error("使い方: status <eventId> <" + VALID_EVENT_STATUSES.join("|") + ">");
  }
  const ok = await updateEventStatus(eventId, status);
  console.log(ok ? "✓ status updated → " + status : "✗ 変更されませんでした");
}

async function cmdParticipants(argv) {
  const eventId = parseInt(argv[3], 10);
  if (!eventId) throw new Error("eventId 必須: participants <eventId>");
  const list = await getParticipants(eventId);
  if (list.length === 0) {
    console.log("(参加者は0件です)");
    return;
  }
  console.log("=== 参加者一覧 eventId=" + eventId + " (" + list.length + "件) ===");
  for (const p of list) {
    console.log(
      "  " + p.line_user_id +
      "  | " + p.status.padEnd(10) +
      "  | " + (p.user_company_name || "—") + " (" + (p.sales_tier || "—") + ")" +
      "  invited=" + fmtDate(p.invited_at) +
      "  responded=" + fmtDate(p.responded_at)
    );
  }
}

async function cmdSetParticipant(argv) {
  const eventId = parseInt(argv[3], 10);
  const lineUserId = argv[4];
  const status = argv[5];
  if (!eventId || !lineUserId || !status) {
    throw new Error(
      "使い方: set-participant <eventId> <lineUserId> <" +
      VALID_PARTICIPANT_STATUSES.join("|") + ">"
    );
  }
  const ok = await setParticipantStatus(eventId, lineUserId, status);
  console.log(ok ? "✓ participant status updated → " + status : "✗ 変更されませんでした（該当なし？）");
}

async function main() {
  const argv = process.argv;
  const cmd = argv[2];
  if (!cmd) {
    console.error("使い方: node scripts/create-consultation.js <list|show|create|invite|status|participants|set-participant> ...");
    process.exit(1);
  }

  try {
    if (cmd === "list") await cmdList(argv);
    else if (cmd === "show") await cmdShow(argv);
    else if (cmd === "create") await cmdCreate(argv);
    else if (cmd === "invite") await cmdInvite(argv);
    else if (cmd === "status") await cmdStatus(argv);
    else if (cmd === "participants") await cmdParticipants(argv);
    else if (cmd === "set-participant") await cmdSetParticipant(argv);
    else {
      console.error("未知のサブコマンド: " + cmd);
      process.exit(1);
    }
  } finally {
    await getPool().end();
  }
}

main().catch((err) => {
  console.error("[create-consultation] error:", err.message || err);
  process.exit(1);
});
