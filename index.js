// .env をロード（ローカル開発用、App Service 等の本番では設定済の環境変数を使うので no-op）
try { require("dotenv").config(); } catch (_e) { /* dotenv 未インストールでも動く */ }

const path = require("path");
const express = require("express");
const { messagingApi, middleware } = require("@line/bot-sdk");
const { handleEvent } = require("./src/handlers");
const { runDelivery } = require("./src/delivery_runner");
const { notifyError } = require("./src/error_notifier");
const { getPool, getRecentDeliveries } = require("./src/db");
const { liffAuthMiddleware } = require("./src/liff_auth");

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const clientConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new messagingApi.MessagingApiClient(clientConfig);
const app = express();

// JSON ボディ用パーサ（/admin/* と /api/* で使う。LINE webhook 側は middleware が独自に処理するので競合しない）
app.use("/admin", express.json({ limit: "32kb" }));
app.use("/api", express.json({ limit: "32kb" }));

// LIFF アプリの静的配信 (B3)
// public/liff/* を https://<host>/liff/* で配信
app.use(
  "/liff",
  express.static(path.join(__dirname, "public", "liff"), {
    fallthrough: true,
    extensions: ["html"],
  })
);

// ヘルスチェック用（LINEのWebhookより先に定義）
app.get("/", (req, res) => {
  res.send("LINE MVP API is running!");
});

// LINE Webhook
app.post("/webhook", middleware(config), async (req, res) => {
  const events = req.body.events || [];

  // すべてのイベントを処理しつつ、エラーは個別にログ。
  // LINE 側には常に200を返す（再送ループを避けるため）。
  await Promise.all(
    events.map(async (event) => {
      try {
        await handleEvent(client, event);
      } catch (err) {
        console.error("[webhook] event handler failed:", err);
        // 監視: Slack/コンソールにエラー通知（重複抑制あり）
        notifyError(err, {
          source: "webhook",
          eventType: event && event.type,
          messageType: event && event.message && event.message.type,
          lineUserId: event && event.source && event.source.userId,
        }).catch((e) => console.error("[webhook] notifyError failed:", e.message));
      }
    })
  );

  res.json({ success: true });
});

// =====================================================================
// 管理用エンドポイント (Phase A1: 週1配信スケジューラ)
// =====================================================================
// X-Admin-Token ヘッダで認証する。GitHub Actions cron 等から叩く想定。
// ADMIN_TOKEN が未設定だと無効化（誤って外部に公開されるのを防ぐ）。
function adminTokenGuard(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({
      ok: false,
      error: "ADMIN_TOKEN not configured on the server",
    });
  }
  const got = req.get("x-admin-token") || req.get("X-Admin-Token");
  if (got !== expected) {
    return res.status(401).json({ ok: false, error: "invalid admin token" });
  }
  next();
}

/**
 * POST /admin/run-delivery
 *  Body (任意): { userId?: string, limit?: number, dryRun?: boolean }
 *  Header: X-Admin-Token: <ADMIN_TOKEN>
 *  Response: { ok, mode, total, sent, skipped, failed, results }
 */
app.post("/admin/run-delivery", adminTokenGuard, async (req, res) => {
  const body = req.body || {};
  const args = {
    userId: typeof body.userId === "string" ? body.userId : null,
    limit: body.limit != null ? parseInt(body.limit, 10) : 3,
    dryRun: !!body.dryRun,
    client, // 既に作ってあるクライアントを使い回す
  };
  try {
    const result = await runDelivery(args);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[admin/run-delivery] failed:", err);
    notifyError(err, { source: "admin/run-delivery" }).catch((e) =>
      console.error("[admin/run-delivery] notifyError failed:", e.message)
    );
    res.status(500).json({
      ok: false,
      error: (err && err.message) || String(err),
    });
  }
});

// =====================================================================
// LIFF API (B3 配信履歴)
// =====================================================================

/**
 * GET /api/me/deliveries
 *   Header: Authorization: Bearer <LIFF_ID_TOKEN>
 *   開発時は Bearer dev-mock + LIFF_DEV_MOCK_USER_ID 環境変数で代替可
 *   Response: { ok, items: [{ id, initiative_id, delivered_at, feedback,
 *                              title, category, company_name }, ...] }
 *
 *   ?limit=30 (max 50)
 */
app.get("/api/me/deliveries", liffAuthMiddleware, async (req, res) => {
  const lineUserId = req.lineUserId;
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 30));
  try {
    const items = await getRecentDeliveries(lineUserId, limit);
    res.json({ ok: true, items, limit });
  } catch (err) {
    console.error("[api/me/deliveries] failed:", err);
    notifyError(err, { source: "api/me/deliveries", lineUserId }).catch(() => {});
    res.status(500).json({ ok: false, error: (err && err.message) || "internal error" });
  }
});

/**
 * GET /admin/health
 *   Header: X-Admin-Token: <ADMIN_TOKEN>
 *   外部 cron 等で死活監視に使う。
 *   - DB に SELECT 1 投げる
 *   - 必須環境変数の有無を確認
 *   ステータス: healthy / degraded
 *   Response 200 (healthy) or 503 (degraded)
 */
app.get("/admin/health", adminTokenGuard, async (_req, res) => {
  const checks = {
    db: { ok: false, detail: null },
    env: { ok: false, missing: [] },
  };

  // 必須環境変数チェック
  const requiredEnv = [
    "LINE_CHANNEL_SECRET",
    "LINE_CHANNEL_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY",
    "MYSQL_HOST",
    "MYSQL_USER",
    "MYSQL_PASSWORD",
    "MYSQL_DATABASE",
  ];
  for (const k of requiredEnv) {
    if (!process.env[k]) checks.env.missing.push(k);
  }
  checks.env.ok = checks.env.missing.length === 0;

  // DB ping
  try {
    const pool = getPool();
    const [rows] = await pool.execute("SELECT 1 AS ok");
    checks.db.ok = !!(rows && rows[0] && rows[0].ok === 1);
    checks.db.detail = "SELECT 1 = " + (rows && rows[0] && rows[0].ok);
  } catch (err) {
    checks.db.ok = false;
    checks.db.detail = (err && err.message) || String(err);
  }

  const healthy = checks.db.ok && checks.env.ok;
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    status: healthy ? "healthy" : "degraded",
    checks,
    ts: new Date().toISOString(),
  });
});

// =====================================================================
// グローバルエラーハンドラ (A3 エラー監視)
// =====================================================================
// 上記のtry-catchで拾えなかった例外を最終キャッチ。

// Express の error middleware: 同期/promise 例外を集約
app.use((err, _req, res, _next) => {
  console.error("[express] unhandled error:", err);
  notifyError(err, { source: "express_unhandled" }).catch((e) =>
    console.error("[express] notifyError failed:", e.message)
  );
  if (!res.headersSent) {
    res.status(500).json({
      ok: false,
      error: (err && err.message) || "internal error",
    });
  }
});

// Node プロセスレベル: 想定外の Promise 例外
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
  notifyError(reason, { source: "process.unhandledRejection" }).catch(() => {});
});

// Node プロセスレベル: 想定外の同期例外（ここに来るとプロセスは落ちる前提）
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException:", err);
  notifyError(err, { source: "process.uncaughtException" })
    .catch(() => {})
    .finally(() => {
      // 致命的エラーなのでプロセスは落とす（PM2/App Service が再起動する）
      // 通知が届く時間を待つために少し遅延
      setTimeout(() => process.exit(1), 1000);
    });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
