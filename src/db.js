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

/**
 * LINE displayName を Users テーブルに保存。
 * Phase 7-1：管理画面の /users で実名を表示するために handleFollow で呼び出す。
 * 既存行が無ければ作成（state=NEW）してから上書き。
 */
async function setDisplayName(lineUserId, displayName) {
  if (!lineUserId || !displayName) return;
  const p = getPool();
  await p.execute(
    "INSERT INTO Users (line_user_id, state, display_name) VALUES (?, 'NEW', ?) " +
    "ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), updated_at = CURRENT_TIMESTAMP(3)",
    [lineUserId, displayName]
  );
}

/**
 * Users.state を任意の値に更新する。
 * Phase 7-1++：AWAITING_REP_NAME 等の遷移に使う。
 */
async function setUserState(lineUserId, newState) {
  if (!lineUserId || !newState) return;
  const p = getPool();
  await p.execute(
    "UPDATE Users SET state = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE line_user_id = ?",
    [newState, lineUserId]
  );
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

// =====================================================================
// リッチメニュー用 (#24)
// =====================================================================

/** 確定済みの最新 Profile を1件返す（リッチメニュー「マイプロファイル」用） */
async function getLatestProfile(lineUserId) {
  const p = getPool();
  const [rows] = await p.execute(
    "SELECT p.id, p.line_user_id, p.approved_company_id, " +
    "       p.company_name, p.company_url, p.sales_tier, p.annual_sales, " +
    "       p.profile_json, p.created_at, " +
    "       ac.prefecture, ac.industry_major " +
    "FROM Profiles p " +
    "LEFT JOIN ApprovedCompanies ac ON ac.id = p.approved_company_id " +
    "WHERE p.line_user_id = ? " +
    "ORDER BY p.created_at DESC LIMIT 1",
    [lineUserId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const profile =
    typeof r.profile_json === "string"
      ? JSON.parse(r.profile_json)
      : r.profile_json || {};
  return {
    lineUserId: r.line_user_id,
    approvedCompanyId: r.approved_company_id,
    companyName: r.company_name,
    companyUrl: r.company_url,
    salesTier: r.sales_tier,
    annualSales: r.annual_sales,
    prefecture: r.prefecture,
    industryMajor: r.industry_major,
    createdAt: r.created_at,
    profile,
  };
}

/** 直近の配信履歴 N 件（リッチメニュー「配信履歴」用） */
async function getRecentDeliveries(lineUserId, limit = 5) {
  const p = getPool();
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 5));
  const [rows] = await p.execute(
    "SELECT dl.id, dl.initiative_id, dl.delivered_at, dl.feedback, " +
    "       i.title, i.category, " +
    "       ac.company_name " +
    "FROM DeliveryLog dl " +
    "JOIN Initiatives i ON i.id = dl.initiative_id " +
    "JOIN ApprovedCompanies ac ON ac.id = i.approved_company_id " +
    "WHERE dl.line_user_id = ? " +
    "ORDER BY dl.delivered_at DESC LIMIT " + safeLimit,
    [lineUserId]
  );
  return rows;
}

/** ユーザーの未消化「話を聞きたい」一覧（リッチメニュー「話を聞きたい一覧」用） */
async function getPendingMatchingForUser(lineUserId, limit = 10) {
  const p = getPool();
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
  const [rows] = await p.execute(
    "SELECT mr.id, mr.target_approved_company_id, mr.status, " +
    "       mr.requested_at, " +
    "       ac.company_name, ac.prefecture, " +
    "       i.title AS source_title " +
    "FROM MatchingRequests mr " +
    "JOIN ApprovedCompanies ac ON ac.id = mr.target_approved_company_id " +
    "LEFT JOIN Initiatives i ON i.id = mr.source_initiative_id " +
    "WHERE mr.line_user_id = ? AND mr.status = 'pending' " +
    "ORDER BY mr.requested_at DESC LIMIT " + safeLimit,
    [lineUserId]
  );
  return rows;
}

/**
 * ユーザーの過去フィードバックを category 別に集計してバイアス値を返す。
 * 使用例 (Phase 6): recommend.js の scoreInitiative に渡す。
 * 戻り値: { "DX": +2, "M&A": -1, ... }
 *   - helpful 1件 → +1
 *   - not_helpful 1件 → -1
 *   - feedback null は無視
 */
async function getCategoryFeedbackBias(lineUserId) {
  const p = getPool();
  const [rows] = await p.execute(
    "SELECT i.category AS category, dl.feedback AS feedback, COUNT(*) AS n " +
    "FROM DeliveryLog dl " +
    "JOIN Initiatives i ON i.id = dl.initiative_id " +
    "WHERE dl.line_user_id = ? " +
    "  AND dl.feedback IN ('helpful', 'not_helpful') " +
    "  AND i.category IS NOT NULL AND i.category <> '' " +
    "GROUP BY i.category, dl.feedback",
    [lineUserId]
  );
  const bias = {};
  for (const r of rows) {
    const cat = r.category;
    const v = r.feedback === "helpful" ? Number(r.n) : -Number(r.n);
    bias[cat] = (bias[cat] || 0) + v;
  }
  return bias;
}

/**
 * 協調フィルタリング (D2):
 * 「自分が helpful にした事例」と「他ユーザーが helpful にした事例」の重なりが
 * 1件以上ある＝類似ユーザー、と定義し、その類似ユーザー集団が helpful にした
 * 事例ごとの件数を返す。自分自身のフィードバックは除外する。
 *
 *   戻り値: { initiative_id: collabScore (=類似ユーザー何人がhelpfulしたか), ... }
 *
 * 例:
 *   ユーザーA が事例 X を helpful
 *   ユーザーB が事例 X, Y を helpful
 *   ユーザーC が事例 X, Z を helpful
 *   ユーザーD が事例 W を helpful （Aと共通なし）
 *   → A の類似ユーザー = B, C （X が共通）
 *   → A への collabScores = { Y: 1, Z: 1 }（XとWは含めない: XはAも済、WはDがAと非類似）
 */
async function getCollaborativeScores(lineUserId, opts = {}) {
  const minOverlap = Math.max(1, parseInt(opts.minOverlap, 10) || 1);
  const p = getPool();
  // 自分が helpful にした initiatives
  const [myRows] = await p.execute(
    "SELECT DISTINCT initiative_id FROM DeliveryLog " +
    "WHERE line_user_id = ? AND feedback = 'helpful'",
    [lineUserId]
  );
  const myHelpful = myRows.map((r) => r.initiative_id);
  if (myHelpful.length === 0) return {};

  // myHelpful と minOverlap 件以上重複している他ユーザーを抽出
  const placeholders = myHelpful.map(() => "?").join(",");
  const [simRows] = await p.execute(
    "SELECT line_user_id, COUNT(DISTINCT initiative_id) AS overlap " +
    "FROM DeliveryLog " +
    "WHERE feedback = 'helpful' AND line_user_id <> ? " +
    "  AND initiative_id IN (" + placeholders + ") " +
    "GROUP BY line_user_id " +
    "HAVING overlap >= ?",
    [lineUserId, ...myHelpful, minOverlap]
  );
  const similarUsers = simRows.map((r) => r.line_user_id);
  if (similarUsers.length === 0) return {};

  // 類似ユーザーが helpful にした initiatives を集計（自分が既に helpful したものは除外）
  const userPlace = similarUsers.map(() => "?").join(",");
  const myPlace = myHelpful.map(() => "?").join(",");
  const [scoreRows] = await p.execute(
    "SELECT initiative_id, COUNT(DISTINCT line_user_id) AS n " +
    "FROM DeliveryLog " +
    "WHERE feedback = 'helpful' " +
    "  AND line_user_id IN (" + userPlace + ") " +
    "  AND initiative_id NOT IN (" + myPlace + ") " +
    "GROUP BY initiative_id",
    [...similarUsers, ...myHelpful]
  );
  const out = {};
  for (const r of scoreRows) {
    out[r.initiative_id] = Number(r.n);
  }
  return out;
}

/** ユーザーの interests（関心テーマ）をすべてクリア（リッチメニュー「設定」用） */
async function clearUserInterests(lineUserId) {
  const p = getPool();
  await p.execute(
    "UPDATE Users SET interests = NULL, " +
    "  updated_at = CURRENT_TIMESTAMP(3) " +
    "WHERE line_user_id = ?",
    [lineUserId]
  );
}

module.exports = {
  getPool,
  findApprovedCompanies,
  findApprovedCompaniesWithPrefecture,
  classifySalesTier,
  getOrCreateUser,
  setDisplayName,
  setUserState,
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
  // Rich Menu (#24)
  getLatestProfile,
  getRecentDeliveries,
  getPendingMatchingForUser,
  clearUserInterests,
  // Phase 6 (フィードバック→レコメンド改善)
  getCategoryFeedbackBias,
  // D2 (協調フィルタリング)
  getCollaborativeScores,
};
