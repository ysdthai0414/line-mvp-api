// 相談会 (Phase 3b-1) のCRUDと参加者管理
//
// 主要API:
//   createEvent({...})                              ConsultationEvents 1行作成
//   getEvent(eventId)                               1件取得（参加者件数集計付き）
//   listEvents({status, limit})                     一覧
//   updateEventStatus(eventId, status)              ステータス遷移
//   updateEventFields(eventId, fields)              基本情報の編集
//
//   getParticipants(eventId)                        参加者一覧
//   setParticipantStatus(eventId, lineUserId, ...)  個別ステータス変更
//
//   inviteParticipantsFromMatchingRequests(eventId, companyId)
//        その会社へ pending な MatchingRequests を持つユーザーを 'invited' で一括登録
//        既に登録済みのユーザーはスキップ
//        対応する MatchingRequest は 'queued_for_event' に進める

const { getPool } = require("./db");

const VALID_EVENT_STATUSES = [
  "planned",
  "recruiting",
  "confirmed",
  "held",
  "cancelled",
];

const VALID_PARTICIPANT_STATUSES = [
  "invited",
  "joined",
  "declined",
  "attended",
  "absent",
  "cancelled",
];

function assertEventStatus(s) {
  if (!VALID_EVENT_STATUSES.includes(s)) {
    throw new Error(
      "invalid event status: " + s +
      " (allowed: " + VALID_EVENT_STATUSES.join(", ") + ")"
    );
  }
}
function assertParticipantStatus(s) {
  if (!VALID_PARTICIPANT_STATUSES.includes(s)) {
    throw new Error(
      "invalid participant status: " + s +
      " (allowed: " + VALID_PARTICIPANT_STATUSES.join(", ") + ")"
    );
  }
}

/**
 * 相談会を作成。
 * args = {
 *   hostCompanyId, title, description, scheduledAt (Date|string),
 *   durationMinutes, zoomUrl, capacity, status, notes
 * }
 */
async function createEvent(args) {
  const {
    hostCompanyId,
    title,
    description = null,
    scheduledAt,
    durationMinutes = 60,
    zoomUrl = null,
    capacity = 0,
    status = "planned",
    notes = null,
  } = args;
  if (!hostCompanyId) throw new Error("hostCompanyId is required");
  if (!title) throw new Error("title is required");
  if (!scheduledAt) throw new Error("scheduledAt is required");
  assertEventStatus(status);

  const pool = getPool();
  const [result] = await pool.execute(
    "INSERT INTO ConsultationEvents " +
    "(host_approved_company_id, title, description, scheduled_at, " +
    " duration_minutes, zoom_url, capacity, status, notes) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, " +
    "        CASE WHEN ? IS NULL THEN NULL ELSE CAST(? AS JSON) END)",
    [
      hostCompanyId,
      title,
      description,
      new Date(scheduledAt),
      durationMinutes,
      zoomUrl,
      capacity,
      status,
      notes ? JSON.stringify(notes) : null,
      notes ? JSON.stringify(notes) : null,
    ]
  );
  return result.insertId;
}

/**
 * 相談会を1件取得（host_company の名前と、参加者ステータス別件数を集計して返す）。
 */
async function getEvent(eventId) {
  const pool = getPool();
  const [eventRows] = await pool.execute(
    "SELECT ce.*, ac.company_name AS host_company_name, ac.prefecture AS host_prefecture " +
    "FROM ConsultationEvents ce " +
    "JOIN ApprovedCompanies ac ON ac.id = ce.host_approved_company_id " +
    "WHERE ce.id = ?",
    [eventId]
  );
  if (eventRows.length === 0) return null;
  const event = eventRows[0];

  const [partRows] = await pool.execute(
    "SELECT status, COUNT(*) AS n FROM ConsultationParticipants " +
    "WHERE consultation_event_id = ? GROUP BY status",
    [eventId]
  );
  const counts = {};
  for (const r of partRows) counts[r.status] = r.n;
  event.participant_counts = counts;
  return event;
}

/**
 * 相談会の一覧取得。filters = { status?, hostCompanyId?, limit? }
 */
async function listEvents(filters = {}) {
  const pool = getPool();
  const where = [];
  const params = [];
  if (filters.status) {
    assertEventStatus(filters.status);
    where.push("ce.status = ?");
    params.push(filters.status);
  }
  if (filters.hostCompanyId) {
    where.push("ce.host_approved_company_id = ?");
    params.push(filters.hostCompanyId);
  }
  const whereSql = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
  const safeLimit = Math.max(1, Math.min(200, parseInt(filters.limit, 10) || 50));

  const [rows] = await pool.execute(
    "SELECT ce.id, ce.host_approved_company_id, ce.title, ce.scheduled_at, " +
    "       ce.duration_minutes, ce.capacity, ce.status, ce.created_at, " +
    "       ac.company_name AS host_company_name, " +
    "       (SELECT COUNT(*) FROM ConsultationParticipants cp " +
    "        WHERE cp.consultation_event_id = ce.id) AS participant_count " +
    "FROM ConsultationEvents ce " +
    "JOIN ApprovedCompanies ac ON ac.id = ce.host_approved_company_id " +
    whereSql + " " +
    "ORDER BY ce.scheduled_at DESC LIMIT " + safeLimit,
    params
  );
  return rows;
}

/** ステータスのみ更新 */
async function updateEventStatus(eventId, status) {
  assertEventStatus(status);
  const pool = getPool();
  const [r] = await pool.execute(
    "UPDATE ConsultationEvents SET status = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
    [status, eventId]
  );
  return r.affectedRows > 0;
}

/** 任意フィールドを部分更新 */
async function updateEventFields(eventId, fields) {
  const allowed = [
    "title",
    "description",
    "scheduled_at",
    "duration_minutes",
    "zoom_url",
    "capacity",
    "archive_url",
    "notes",
  ];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!allowed.includes(k)) continue;
    if (k === "notes") {
      sets.push("notes = CASE WHEN ? IS NULL THEN NULL ELSE CAST(? AS JSON) END");
      params.push(v == null ? null : JSON.stringify(v));
      params.push(v == null ? null : JSON.stringify(v));
    } else if (k === "scheduled_at" && v != null) {
      sets.push("scheduled_at = ?");
      params.push(new Date(v));
    } else {
      sets.push(k + " = ?");
      params.push(v);
    }
  }
  if (sets.length === 0) return false;
  params.push(eventId);
  const pool = getPool();
  const [r] = await pool.execute(
    "UPDATE ConsultationEvents SET " + sets.join(", ") +
    ", updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
    params
  );
  return r.affectedRows > 0;
}

/** 参加者一覧 */
async function getParticipants(eventId) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT cp.id, cp.consultation_event_id, cp.line_user_id, cp.status, " +
    "       cp.source_matching_request_id, cp.invited_at, cp.responded_at, cp.notes, " +
    "       u.approved_company_id, ac.company_name AS user_company_name, " +
    "       u.sales_tier " +
    "FROM ConsultationParticipants cp " +
    "JOIN Users u ON u.line_user_id = cp.line_user_id " +
    "LEFT JOIN ApprovedCompanies ac ON ac.id = u.approved_company_id " +
    "WHERE cp.consultation_event_id = ? " +
    "ORDER BY cp.invited_at ASC",
    [eventId]
  );
  return rows;
}

/**
 * 参加者の status を変更。statusが'joined','declined','attended','absent','cancelled'のいずれかなら responded_at を更新。
 */
async function setParticipantStatus(eventId, lineUserId, status, notes) {
  assertParticipantStatus(status);
  const pool = getPool();
  const setResp = status !== "invited" ? ", responded_at = CURRENT_TIMESTAMP(3)" : "";
  const [r] = await pool.execute(
    "UPDATE ConsultationParticipants SET status = ?, notes = COALESCE(?, notes) " +
    setResp +
    " WHERE consultation_event_id = ? AND line_user_id = ?",
    [status, notes || null, eventId, lineUserId]
  );
  return r.affectedRows > 0;
}

/**
 * 指定 company_id 宛の pending MatchingRequests を持つユーザーを、
 * 当該 ConsultationEvent の Participants に 'invited' として一括登録する。
 *
 * - 既に登録済みのユーザーはスキップ（INSERT IGNORE）
 * - 同時に MatchingRequests.status を 'queued_for_event' に進める
 * - 戻り値: { invited: N, totalPending: M }
 */
async function inviteParticipantsFromMatchingRequests(eventId, companyId) {
  if (!eventId || !companyId) {
    throw new Error("eventId and companyId are required");
  }
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [pendings] = await conn.execute(
      "SELECT id, line_user_id FROM MatchingRequests " +
      "WHERE target_approved_company_id = ? AND status = 'pending' " +
      "ORDER BY requested_at ASC",
      [companyId]
    );

    if (pendings.length === 0) {
      await conn.commit();
      return { invited: 0, totalPending: 0 };
    }

    let inserted = 0;
    for (const p of pendings) {
      const [res] = await conn.execute(
        "INSERT IGNORE INTO ConsultationParticipants " +
        "(consultation_event_id, line_user_id, status, source_matching_request_id) " +
        "VALUES (?, ?, 'invited', ?)",
        [eventId, p.line_user_id, p.id]
      );
      if (res.affectedRows > 0) inserted++;
    }

    // 対応するMatchingRequestsを 'queued_for_event' に進める
    await conn.execute(
      "UPDATE MatchingRequests SET status = 'queued_for_event' " +
      "WHERE target_approved_company_id = ? AND status = 'pending'",
      [companyId]
    );

    await conn.commit();
    return { invited: inserted, totalPending: pendings.length };
  } catch (err) {
    try { await conn.rollback(); } catch (_e) {}
    throw err;
  } finally {
    conn.release();
  }
}

// =====================================================================
// Phase 3b-2 (参加打診 push) 用
// =====================================================================

/**
 * 「invited だが pushed_at がまだ NULL」の参加者を返す。
 * push バッチの対象抽出に使う。
 */
async function getInvitedNotPushed(eventId) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id, line_user_id, status, source_matching_request_id, " +
    "       invited_at, responded_at, pushed_at " +
    "FROM ConsultationParticipants " +
    "WHERE consultation_event_id = ? " +
    "  AND status = 'invited' " +
    "  AND pushed_at IS NULL " +
    "ORDER BY invited_at ASC",
    [eventId]
  );
  return rows;
}

/**
 * push 送信の成功時に pushed_at を CURRENT_TIMESTAMP に更新する。
 * 既に pushed_at がある場合は上書きしない（冪等）。
 */
async function markPushed(eventId, lineUserId) {
  const pool = getPool();
  const [r] = await pool.execute(
    "UPDATE ConsultationParticipants " +
    "SET pushed_at = CURRENT_TIMESTAMP(3) " +
    "WHERE consultation_event_id = ? " +
    "  AND line_user_id = ? " +
    "  AND pushed_at IS NULL",
    [eventId, lineUserId]
  );
  return r.affectedRows > 0;
}

/**
 * テスト・運用デバッグ用。pushed_at をクリアして再 push 可能にする。
 */
async function clearPushedAt(eventId, lineUserId = null) {
  const pool = getPool();
  if (lineUserId) {
    await pool.execute(
      "UPDATE ConsultationParticipants SET pushed_at = NULL " +
      "WHERE consultation_event_id = ? AND line_user_id = ?",
      [eventId, lineUserId]
    );
  } else {
    await pool.execute(
      "UPDATE ConsultationParticipants SET pushed_at = NULL " +
      "WHERE consultation_event_id = ?",
      [eventId]
    );
  }
}

// =====================================================================
// Phase 3b-3 (リマインド + アーカイブ配信) 用
// =====================================================================

/** リマインド対象: status='joined' AND reminded_at IS NULL */
async function getJoinedNotReminded(eventId) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id, line_user_id, status, invited_at, responded_at, " +
    "       pushed_at, reminded_at " +
    "FROM ConsultationParticipants " +
    "WHERE consultation_event_id = ? " +
    "  AND status = 'joined' " +
    "  AND reminded_at IS NULL " +
    "ORDER BY responded_at ASC",
    [eventId]
  );
  return rows;
}

/** リマインド送信成功時に reminded_at を更新（冪等） */
async function markReminded(eventId, lineUserId) {
  const pool = getPool();
  const [r] = await pool.execute(
    "UPDATE ConsultationParticipants " +
    "SET reminded_at = CURRENT_TIMESTAMP(3) " +
    "WHERE consultation_event_id = ? " +
    "  AND line_user_id = ? " +
    "  AND reminded_at IS NULL",
    [eventId, lineUserId]
  );
  return r.affectedRows > 0;
}

/** アーカイブ配信対象: status IN ('joined', 'attended') AND archive_pushed_at IS NULL */
async function getJoinedNotArchivePushed(eventId) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT id, line_user_id, status, archive_pushed_at " +
    "FROM ConsultationParticipants " +
    "WHERE consultation_event_id = ? " +
    "  AND status IN ('joined', 'attended') " +
    "  AND archive_pushed_at IS NULL " +
    "ORDER BY responded_at ASC",
    [eventId]
  );
  return rows;
}

/** アーカイブ配信成功時に archive_pushed_at を更新（冪等） */
async function markArchivePushed(eventId, lineUserId) {
  const pool = getPool();
  const [r] = await pool.execute(
    "UPDATE ConsultationParticipants " +
    "SET archive_pushed_at = CURRENT_TIMESTAMP(3) " +
    "WHERE consultation_event_id = ? " +
    "  AND line_user_id = ? " +
    "  AND archive_pushed_at IS NULL",
    [eventId, lineUserId]
  );
  return r.affectedRows > 0;
}

/**
 * リマインド対象のイベントを抽出する。
 * - scheduled_at が NOW 〜 NOW + hoursAhead 時間以内
 * - status IN ('confirmed', 'recruiting')
 * - status='joined' AND reminded_at IS NULL の participant が1名以上
 */
async function findUpcomingEventsNeedingReminder(hoursAhead = 24) {
  const pool = getPool();
  const safeHours = Math.max(1, Math.min(168, parseInt(hoursAhead, 10) || 24));
  const [rows] = await pool.execute(
    "SELECT ce.id, ce.host_approved_company_id, ce.title, ce.scheduled_at, " +
    "       ce.duration_minutes, ce.zoom_url, ce.status, " +
    "       ac.company_name AS host_company_name, " +
    "       (SELECT COUNT(*) FROM ConsultationParticipants cp " +
    "        WHERE cp.consultation_event_id = ce.id " +
    "          AND cp.status = 'joined' " +
    "          AND cp.reminded_at IS NULL) AS pending_reminders " +
    "FROM ConsultationEvents ce " +
    "JOIN ApprovedCompanies ac ON ac.id = ce.host_approved_company_id " +
    "WHERE ce.scheduled_at BETWEEN NOW() AND (NOW() + INTERVAL ? HOUR) " +
    "  AND ce.status IN ('confirmed', 'recruiting') " +
    "HAVING pending_reminders > 0 " +
    "ORDER BY ce.scheduled_at ASC",
    [safeHours]
  );
  return rows;
}

/**
 * アーカイブ配信対象のイベントを抽出する。
 * - status='held'
 * - archive_url IS NOT NULL
 * - archive_pushed_at IS NULL の participant が1名以上
 */
async function findHeldEventsNeedingArchivePush() {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT ce.id, ce.host_approved_company_id, ce.title, ce.scheduled_at, " +
    "       ce.archive_url, " +
    "       ac.company_name AS host_company_name, " +
    "       (SELECT COUNT(*) FROM ConsultationParticipants cp " +
    "        WHERE cp.consultation_event_id = ce.id " +
    "          AND cp.status IN ('joined', 'attended') " +
    "          AND cp.archive_pushed_at IS NULL) AS pending_archives " +
    "FROM ConsultationEvents ce " +
    "JOIN ApprovedCompanies ac ON ac.id = ce.host_approved_company_id " +
    "WHERE ce.status = 'held' " +
    "  AND ce.archive_url IS NOT NULL " +
    "HAVING pending_archives > 0 " +
    "ORDER BY ce.scheduled_at DESC"
  );
  return rows;
}

/** テスト用：reminded_at / archive_pushed_at を null に戻す */
async function clearReminderArchiveTimestamps(eventId) {
  const pool = getPool();
  await pool.execute(
    "UPDATE ConsultationParticipants SET reminded_at = NULL, archive_pushed_at = NULL " +
    "WHERE consultation_event_id = ?",
    [eventId]
  );
}

module.exports = {
  // event
  createEvent,
  getEvent,
  listEvents,
  updateEventStatus,
  updateEventFields,
  // participants
  getParticipants,
  setParticipantStatus,
  inviteParticipantsFromMatchingRequests,
  // push (Phase 3b-2)
  getInvitedNotPushed,
  markPushed,
  clearPushedAt,
  // reminders & archives (Phase 3b-3)
  getJoinedNotReminded,
  markReminded,
  getJoinedNotArchivePushed,
  markArchivePushed,
  findUpcomingEventsNeedingReminder,
  findHeldEventsNeedingArchivePush,
  clearReminderArchiveTimestamps,
  // constants
  VALID_EVENT_STATUSES,
  VALID_PARTICIPANT_STATUSES,
};
