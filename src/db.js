// Azure Database for MySQL (Flexible Server) 接続 & クエリ
// プールはプロセス内で1つだけ作成する（lazy init）
const mysql = require("mysql2/promise");

const sslEnabled = (process.env.MYSQL_SSL || "true") === "true";
// Azure MySQL Flexible Server の証明書チェーンが Node.js 標準 CA で検証できない環境向けに、
// CA 検証だけスキップする逃げ道を用意（通信は TLS で暗号化されたまま）。
// 本番で厳格に検証したいときは MYSQL_SSL_REJECT_UNAUTHORIZED=true にする。
const sslRejectUnauthorized =
  (process.env.MYSQL_SSL_REJECT_UNAUTHORIZED || "false") === "true";

const config = {
  host: process.env.MYSQL_HOST,
  port: parseInt(process.env.MYSQL_PORT || "3306", 10),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl: sslEnabled
    ? { minVersion: "TLSv1.2", rejectUnauthorized: sslRejectUnauthorized }
    : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  typeCast: true,
  multipleStatements: false,
};

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(config);
    console.log("[db] MySQL connection pool created (host=" + config.host + ", db=" + config.database + ", verify=" + sslRejectUnauthorized + ")");
  }
  return pool;
}

async function findApprovedCompanies(normalizedName) {
  if (!normalizedName) return [];
  const p = getPool();
  const [rows] = await p.execute(
    "SELECT * FROM ApprovedCompanies WHERE company_name_normalized = ? ORDER BY id LIMIT 5",
    [normalizedName]
  );
  return rows;
}

/**
 * 正規化済み社名 + 都道府県 で絞り込み検索。
 * 同名衝突解消のため2段目の照合に使う。
 *  prefecture が空文字/null の場合は findApprovedCompanies と同じ挙動。
 */
async function findApprovedCompaniesWithPrefecture(normalizedName, prefecture) {
  if (!normalizedName) return [];
  if (!prefecture) return findApprovedCompanies(normalizedName);
  const p = getPool();
  const [rows] = await p.execute(
    "SELECT * FROM ApprovedCompanies " +
    "WHERE company_name_normalized = ? AND prefecture = ? " +
    "ORDER BY id LIMIT 5",
    [normalizedName, prefecture]
  );
  return rows;
}

function classifySalesTier(annualSales) {
  if (annualSales == null) return null;
  const oku = Number(annualSales) / 100000000;
  if (oku < 10) return "UNDER_10";
  if (oku < 30) return "10_30";
  if (oku < 50) return "30_50";
  if (oku < 100) return "50_100";
  return "OVER_100";
}

async function getOrCreateUser(lineUserId) {
  const p = getPool();
  const [rows] = await p.execute(
    "SELECT * FROM Users WHERE line_user_id = ?",
    [lineUserId]
  );
  if (rows.length > 0) return rows[0];
  await p.execute(
    "INSERT INTO Users (line_user_id, state) VALUES (?, 'NEW') " +
    "ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP(3)",
    [lineUserId]
  );
  return { line_user_id: lineUserId, state: "NEW" };
}

async function markNotApproved(lineUserId, companyName, companyUrl) {
  const p = getPool();
  await p.execute(
    "INSERT INTO Users (line_user_id, state, pending_company_name, pending_company_url) " +
    "VALUES (?, 'NOT_APPROVED', ?, ?) " +
    "ON DUPLICATE KEY UPDATE " +
    "  state = 'NOT_APPROVED', " +
    "  pending_company_name = VALUES(pending_company_name), " +
    "  pending_company_url = VALUES(pending_company_url), " +
    "  updated_at = CURRENT_TIMESTAMP(3)",
    [lineUserId, companyName, companyUrl]
  );
}

/**
 * 同名衝突時に都道府県の選択を待つ状態に遷移させる。
 * 入力された 会社名・URL は pending_* に保存し、postback で都道府県が
 * 選択されたタイミングで再照合に使う。
 */
async function saveAwaitingPrefecture(lineUserId, companyName, companyUrl) {
  const p = getPool();
  await p.execute(
    "INSERT INTO Users " +
    "(line_user_id, state, pending_company_name, pending_company_url) " +
    "VALUES (?, 'AWAITING_PREFECTURE', ?, ?) " +
    "ON DUPLICATE KEY UPDATE " +
    "  state = 'AWAITING_PREFECTURE', " +
    "  pending_company_name = VALUES(pending_company_name), " +
    "  pending_company_url = VALUES(pending_company_url), " +
    "  pending_profile_json = NULL, " +
    "  updated_at = CURRENT_TIMESTAMP(3)",
    [lineUserId, companyName, companyUrl]
  );
}

/** AWAITING_PREFECTURE 中に保存しておいた会社名/URLを取り出す */
async function getPendingCompanyInput(lineUserId) {
  const p = getPool();
  const [rows] = await p.execute(
    "SELECT pending_company_name, pending_company_url, state " +
    "FROM Users WHERE line_user_id = ?",
    [lineUserId]
  );
  if (rows.length === 0) return null;
  return {
    companyName: rows[0].pending_company_name || null,
    companyUrl: rows[0].pending_company_url || null,
    state: rows[0].state || null,
  };
}

async function savePendingProfile(args) {
  const {
    lineUserId, companyName, companyUrl,
    approvedCompanyId, annualSales, salesTier, profile,
  } = args;
  const p = getPool();
  const profileJson = JSON.stringify(profile);
  await p.execute(
    "INSERT INTO Users " +
    "(line_user_id, state, approved_company_id, annual_sales, sales_tier, " +
    " pending_company_name, pending_company_url, pending_profile_json) " +
    "VALUES (?, 'AWAITING_CONFIRM', ?, ?, ?, ?, ?, CAST(? AS JSON)) " +
    "ON DUPLICATE KEY UPDATE " +
    "  state = 'AWAITING_CONFIRM', " +
    "  approved_company_id = VALUES(approved_company_id), " +
    "  annual_sales = VALUES(annual_sales), " +
    "  sales_tier = VALUES(sales_tier), " +
    "  pending_company_name = VALUES(pending_company_name), " +
    "  pending_company_url = VALUES(pending_company_url), " +
    "  pending_profile_json = VALUES(pending_profile_json), " +
    "  updated_at = CURRENT_TIMESTAMP(3)",
    [
      lineUserId,
      approvedCompanyId || null,
      annualSales || null,
      salesTier || null,
      companyName, companyUrl, profileJson,
    ]
  );
}

async function commitPendingProfile(lineUserId) {
  const p = getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT pending_company_name, pending_company_url, pending_profile_json, " +
      "       approved_company_id, sales_tier, annual_sales " +
      "FROM Users WHERE line_user_id = ? FOR UPDATE",
      [lineUserId]
    );
    if (rows.length === 0) throw new Error("User not found: " + lineUserId);
    const row = rows[0];
    if (!row.pending_profile_json) throw new Error("No pending profile to commit");

    const profileJson =
      typeof row.pending_profile_json === "string"
        ? row.pending_profile_json
        : JSON.stringify(row.pending_profile_json);

    await conn.execute(
      "INSERT INTO Profiles " +
      "(line_user_id, approved_company_id, company_name, company_url, " +
      " sales_tier, annual_sales, profile_json) " +
      "VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))",
      [
        lineUserId, row.approved_company_id,
        row.pending_company_name, row.pending_company_url,
        row.sales_tier, row.annual_sales, profileJson,
      ]
    );
    await conn.execute(
      "UPDATE Users SET state='CONFIRMED', " +
      "  pending_company_name=NULL, pending_company_url=NULL, " +
      "  pending_profile_json=NULL, updated_at=CURRENT_TIMESTAMP(3) " +
      "WHERE line_user_id = ?",
      [lineUserId]
    );
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch (_e) {}
    throw err;
  } finally {
    conn.release();
  }
}

async function discardPendingProfile(lineUserId) {
  const p = getPool();
  await p.execute(
    "UPDATE Users SET state='NEW', " +
    "  pending_company_name=NULL, pending_company_url=NULL, " +
    "  pending_profile_json=NULL, updated_at=CURRENT_TIMESTAMP(3) " +
    "WHERE line_user_id = ?",
    [lineUserId]
  );
}

// =====================================================================
// Phase 3: パーソナライズ + フィードバック
// =====================================================================

async function addUserInterest(lineUserId, category) {
  if (!category) return;
  const p = getPool();
  const [rows] = await p.execute(
    "SELECT interests FROM Users WHERE line_user_id = ?",
    [lineUserId]
  );
  let arr = [];
  if (rows.length > 0 && rows[0].interests) {
    arr =
      typeof rows[0].interests === "string"
        ? JSON.parse(rows[0].interests)
        : rows[0].interests;
    if (!Array.isArray(arr)) arr = [];
  }
  if (!arr.includes(category)) arr.push(category);
  await p.execute(
    "UPDATE Users SET interests = CAST(? AS JSON), updated_at = CURRENT_TIMESTAMP(3) " +
    "WHERE line_user_id = ?",
    [JSON.stringify(arr), lineUserId]
  );
}

async function addUserDislikedCategory(lineUserId, category) {
  if (!category) return;
  const p = getPool();
  const [rows] = await p.execute(
    "SELECT disliked_categories FROM Users WHERE line_user_id = ?",
    [lineUserId]
  );
  let arr = [];
  if (rows.length > 0 && rows[0].disliked_categories) {
    arr =
      typeof rows[0].disliked_categories === "string"
        ? JSON.parse(rows[0].disliked_categories)
        : rows[0].disliked_categories;
    if (!Array.isArray(arr)) arr = [];
  }
  if (!arr.includes(category)) arr.push(category);
  await p.execute(
    "UPDATE Users SET disliked_categories = CAST(? AS JSON), updated_at = CURRENT_TIMESTAMP(3) " +
    "WHERE line_user_id = ?",
    [JSON.stringify(arr), lineUserId]
  );
}

async function setDeliveryFeedback(lineUserId, initiativeId, feedback) {
  const p = getPool();
  await p.execute(
    "UPDATE DeliveryLog SET feedback = ?, feedback_at = CURRENT_TIMESTAMP(3) " +
    "WHERE line_user_id = ? AND initiative_id = ?",
    [feedback, lineUserId, initiativeId]
  );
}

async function getInitiativeById(initiativeId) {
  const p = getPool();
  const [rows] = await p.execute(
    "SELECT i.*, ac.company_name " +
    "FROM Initiatives i " +
    "JOIN ApprovedCompanies ac ON ac.id = i.approved_company_id " +
    "WHERE i.id = ?",
    [initiativeId]
  );
  return rows[0] || null;
}

async function getUserPreferences(lineUserId) {
  const p = getPool();
  const [rows] = await p.execute(
    "SELECT interests, disliked_categories FROM Users WHERE line_user_id = ?",
    [lineUserId]
  );
  if (rows.length === 0) return { interests: [], dislikedCategories: [] };
  const r = rows[0];
  const parse = (v) =>
    !v ? [] : typeof v === "string" ? JSON.parse(v) : Array.isArray(v) ? v : [];
  return {
    interests: parse(r.interests),
    dislikedCategories: parse(r.disliked_categories),
  };
}

// =====================================================================
// Phase 4: 関心テーマ Quick Reply の最大表示回数制御
// =====================================================================

/** 「マッチせず」を押されたタイミングで、QR再表示を許す残り回数を設定 */
async function setPendingInterestPicks(lineUserId, n) {
  const p = getPool();
  await p.execute(
    "UPDATE Users SET pending_interest_picks = ?, " +
    "  updated_at = CURRENT_TIMESTAMP(3) " +
    "WHERE line_user_id = ?",
    [n, lineUserId]
  );
}

/**
 * 関心テーマが選ばれたときに残り表示回数を1減らす。
 * 残り>0 だった場合は true（QR再表示すべし）、0以下だった場合は false（最終メッセージ）
 */
async function consumePendingInterestPick(lineUserId) {
  const p = getPool();
  const [result] = await p.execute(
    "UPDATE Users SET pending_interest_picks = pending_interest_picks - 1, " +
    "  updated_at = CURRENT_TIMESTAMP(3) " +
    "WHERE line_user_id = ? AND pending_interest_picks > 0",
    [lineUserId]
  );
  return result.affectedRows > 0;
}

module.exports = {
  getPool,
  findApprovedCompanies,
  findApprovedCompaniesWithPrefecture,
  classifySalesTier,
  getOrCreateUser,
  markNotApproved,
  saveAwaitingPrefecture,
  getPendingCompanyInput,
  savePendingProfile,
  commitPendingProfile,
  discardPendingProfile,
  // Phase 3
  addUserInterest,
  addUserDislikedCategory,
  setDeliveryFeedback,
  getInitiativeById,
  getUserPreferences,
  // Phase 4
  setPendingInterestPicks,
  consumePendingInterestPick,
};
