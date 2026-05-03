// 月1（または週1）配信のコアロジック (Phase 2 / A1)
//
// 既存の scripts/run-delivery.js を CLI 専用にしていたが、
// HTTP エンドポイント (/admin/run-delivery) からも呼べるよう関数化したもの。
//
// 利用元:
//   - scripts/run-delivery.js (CLI)
//   - index.js  (POST /admin/run-delivery)
//
// 注意:
//   - LINE Push API のレート制限を考慮して 500ms 間隔で逐次送信
//   - dryRun=true なら LINE 送信せず、件数集計だけ行う
//   - 失敗時も他ユーザーは続行（部分失敗を許容）
const { messagingApi } = require("@line/bot-sdk");
const { getPool, getLatestProfile } = require("./db");
const { recommendForUser } = require("./recommend");
const { buildDeliveryCarouselFlex } = require("./flex");
const reasonAi = require("./reason_ai"); // module 経由（テストで差替え可）

const DEFAULT_LIMIT = 3;
const DEFAULT_SLEEP_MS = 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listTargetUsers({ userId }) {
  const pool = getPool();
  if (userId) {
    const [rows] = await pool.execute(
      "SELECT line_user_id FROM Users WHERE line_user_id = ? AND state = 'CONFIRMED'",
      [userId]
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
  await pool.execute(
    "INSERT IGNORE INTO DeliveryLog (line_user_id, initiative_id) VALUES " +
      placeholders,
    flat
  );
}

/**
 * Claude で各 initiative の動的推薦理由を生成して、_reasons._dynamicReason に格納する (D1)。
 * 失敗した item は静的テンプレにフォールバックされるので、エラーは握りつぶす。
 */
async function attachDynamicReasons(lineUserId, recs, opts) {
  const { mockAi, logger, useDynamicReason } = opts || {};
  if (!useDynamicReason) return;
  if (!recs || recs.length === 0) return;

  let userCtx = null;
  try {
    userCtx = await getLatestProfile(lineUserId);
  } catch (e) {
    if (logger) logger.warn("[delivery] getLatestProfile failed:", e.message);
  }

  const userArg = userCtx
    ? {
        companyName: userCtx.companyName,
        salesTier: userCtx.salesTier,
        profile: userCtx.profile,
        interests: [], // recommend 側で interests は反映済みだが、文章生成用に渡したいので別途取得しても良い
      }
    : { companyName: "御社", salesTier: null, profile: {}, interests: [] };

  for (const r of recs) {
    try {
      const text = await reasonAi.generateReasonText({
        user: userArg,
        initiative: r,
        reasons: r._reasons || {},
        mockAi: !!mockAi,
      });
      if (text) {
        r._reasons = r._reasons || {};
        r._reasons._dynamicReason = text;
      }
    } catch (e) {
      if (logger) logger.warn("[delivery] reason_ai failed for init=" + r.id + ":", e.message);
    }
  }
}

/**
 * 配信を実行する。
 * args = {
 *   userId,                  // 任意。指定すると1ユーザーだけ対象
 *   limit,                   // 推薦件数（既定 3）
 *   dryRun,                  // 既定 false。true なら LINE 送らない
 *   client,                  // テスト用にモック client を注入可能
 *   sleepMs,                 // テスト用にスリープ間隔を縮められる
 *   logger,                  // 既定 console。ログを抑止したい場合に差し替え
 *   useDynamicReason,        // D1: true で Claude による動的推薦理由を生成（既定: LIVEモードでは true）
 *   mockAi,                  // テスト用。true なら reason_ai はモック文を返す
 * }
 *
 * 戻り値:
 *   { mode, total, sent, skipped, failed, results: [...] }
 *     results は各ユーザーの { lineUserId, status, titles?, error? } の配列
 */
async function runDelivery(args = {}) {
  const userId = args.userId || null;
  const limit = parseInt(args.limit, 10) || DEFAULT_LIMIT;
  const dryRun = !!args.dryRun;
  const sleepMs = args.sleepMs != null ? parseInt(args.sleepMs, 10) : DEFAULT_SLEEP_MS;
  const logger = args.logger || console;
  // dryRun 時は API コストを払わないため既定で false。LIVE 時は既定 true
  const useDynamicReason = typeof args.useDynamicReason === "boolean"
    ? args.useDynamicReason
    : !dryRun;
  const mockAi = !!args.mockAi;

  let client = args.client;
  if (!dryRun && !client) {
    if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      throw new Error("LINE_CHANNEL_ACCESS_TOKEN 未設定。dryRun 以外は実行不可。");
    }
    client = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
  }

  const userIds = await listTargetUsers({ userId });
  logger.log(
    "[delivery] mode=" +
      (dryRun ? "DRY-RUN" : "LIVE") +
      ", userId=" + (userId || "ALL") +
      ", limit=" + limit +
      ", useDynamicReason=" + useDynamicReason +
      ", target users=" + userIds.length
  );

  const results = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const uid of userIds) {
    try {
      const recs = await recommendForUser(uid, limit);
      if (recs.length === 0) {
        logger.log("  - " + uid + ": no recommendations, skip");
        skipped++;
        results.push({ lineUserId: uid, status: "no_recommendations" });
        continue;
      }

      // D1: 動的推薦理由を Claude で生成（失敗時はフォールバック）
      await attachDynamicReasons(uid, recs, { mockAi, logger, useDynamicReason });

      const titles = recs.map((r) => r.title);
      logger.log("  - " + uid + ": " + recs.length + " items → " + titles.join(" / "));

      if (dryRun) {
        skipped++;
        results.push({ lineUserId: uid, status: "dry_run", titles });
        continue;
      }

      const flex = buildDeliveryCarouselFlex(recs);
      await client.pushMessage({ to: uid, messages: [flex] });
      await recordDelivery(uid, recs.map((r) => r.id));
      sent++;
      results.push({ lineUserId: uid, status: "sent", titles });
      if (sleepMs > 0) await sleep(sleepMs);
    } catch (err) {
      failed++;
      logger.error("  - " + uid + ": failed:", err.message || err);
      results.push({ lineUserId: uid, status: "failed", error: err.message || String(err) });
    }
  }

  logger.log(
    "[delivery] done. sent=" + sent +
      ", skipped=" + skipped +
      ", failed=" + failed
  );

  return {
    mode: dryRun ? "dry_run" : "live",
    total: userIds.length,
    sent,
    skipped,
    failed,
    results,
  };
}

module.exports = {
  runDelivery,
  // テスト用に内部関数も export
  listTargetUsers,
  recordDelivery,
  attachDynamicReasons,
};
