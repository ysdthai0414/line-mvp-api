// マッチング申請（「話を聞きたい」）のDB操作
const { getPool } = require("./db");

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

module.exports = {
  recordMatchingRequest,
  getOfferCounts,
};
