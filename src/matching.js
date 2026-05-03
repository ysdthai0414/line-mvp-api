// マッチング申請（「話を聞きたい」）のDB操作 + しきい値検知 + 通知履歴
const { getPool } = require("./db");

const DEFAULT_REPEAT_DAYS = 7; // 同じ会社への通知は直近Nに1回だけ

/**
 * 「話を聞きたい」を1件記録。
 * 同じユーザーから同じ企業への重複申請は許容（後続で集約時に判断）。
 */
async function recordMatchingRequest({
  lineUserId,
  targetCompanyId,
  sourceInitiativeId,
}) {
  const pool = getPool();
  await pool.execute(
    "INSERT INTO MatchingRequests " +
    "(line_user_id, target_approved_company_id, source_initiative_id, status) " +
    "VALUES (?, ?, ?, 'pending')",
    [
      lineUserId,
      targetCompanyId,
      sourceInitiativeId || null,
    ]
  );
}

/**
 * 認可企業ごとの未消化オファー件数を集計。
 * （事務局向け管理画面のため。今は使わないが将来用）
 */
async function getOfferCounts() {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT target_approved_company_id AS company_id, " +
    "       COUNT(*) AS offer_count " +
    "FROM MatchingRequests WHERE status = 'pending' " +
    "GROUP BY target_approved_company_id ORDER BY offer_count DESC"
  );
  return rows;
}

/**
 * しきい値以上のpending件数を持つ会社を集計して返す。
 * 戻り値の各行: { company_id, company_name, prefecture, offer_count, oldest_at, latest_at, requester_count }
 * requester_count は重複ユーザー除外後のオファー人数。
 */
async function findCompaniesAboveThreshold(threshold) {
  if (!threshold || threshold < 1) {
    throw new Error("threshold must be >= 1");
  }
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT mr.target_approved_company_id AS company_id, " +
    "       ac.company_name, ac.prefecture, " +
    "       COUNT(*) AS offer_count, " +
    "       COUNT(DISTINCT mr.line_user_id) AS requester_count, " +
    "       MIN(mr.requested_at) AS oldest_at, " +
    "       MAX(mr.requested_at) AS latest_at " +
    "FROM MatchingRequests mr " +
    "JOIN ApprovedCompanies ac ON ac.id = mr.target_approved_company_id " +
    "WHERE mr.status = 'pending' " +
    "GROUP BY mr.target_approved_company_id, ac.company_name, ac.prefecture " +
    "HAVING COUNT(*) >= ? " +
    "ORDER BY offer_count DESC, oldest_at ASC",
    [threshold]
  );
  return rows;
}

/**
 * 同じ会社へ「直近 days 日以内に成功通知（status='sent' or 'logged'）」されたかを判定。
 * 失敗(failed)は再通知の対象としたいので除外。
 */
async function wasNotifiedRecently(targetCompanyId, days = DEFAULT_REPEAT_DAYS) {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT COUNT(*) AS n FROM MatchingNotifications " +
    "WHERE target_approved_company_id = ? " +
    "  AND status IN ('sent', 'logged') " +
    "  AND notified_at >= (NOW() - INTERVAL ? DAY)",
    [targetCompanyId, days]
  );
  return rows[0] && rows[0].n > 0;
}

/**
 * 通知履歴を1行記録。
 *  args = { targetCompanyId, pendingCount, threshold, channel, status, payload, errorMessage }
 */
async function recordNotification(args) {
  const {
    targetCompanyId,
    pendingCount,
    threshold,
    channel,
    status,
    payload,
    errorMessage,
  } = args;
  const pool = getPool();
  await pool.execute(
    "INSERT INTO MatchingNotifications " +
    "(target_approved_company_id, pending_count_at_notify, threshold_value, " +
    " channel, status, payload, error_message) " +
    "VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?)",
    [
      targetCompanyId,
      pendingCount,
      threshold,
      channel,
      status,
      JSON.stringify(payload || {}),
      errorMessage || null,
    ]
  );
}

/**
 * テスト・デバッグ用：特定会社の最近の通知履歴を取得
 *
 * 注: mysql2 の execute() は LIMIT のパラメータバインドを扱えないため、
 *     limit は parseInt で整数化してSQLに直接埋め込む（int固定なのでSQLi安全）。
 */
async function getRecentNotifications(targetCompanyId, limit = 5) {
  const pool = getPool();
  const safeLimit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 5));
  const [rows] = await pool.execute(
    "SELECT id, pending_count_at_notify, threshold_value, channel, status, " +
    "       error_message, notified_at " +
    "FROM MatchingNotifications " +
    "WHERE target_approved_company_id = ? " +
    "ORDER BY notified_at DESC LIMIT " + safeLimit,
    [targetCompanyId]
  );
  return rows;
}

module.exports = {
  recordMatchingRequest,
  getOfferCounts,
  findCompaniesAboveThreshold,
  wasNotifiedRecently,
  recordNotification,
  getRecentNotifications,
  DEFAULT_REPEAT_DAYS,
};
