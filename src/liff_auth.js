// LIFF (LINE Front-end Framework) 認証ヘルパー (B3)
//
// LIFF v2 の ID Token を Bearer で受け取り、LINE の verify API で検証して
// line_user_id を req.lineUserId にセットする Express ミドルウェアを提供する。
//
// 仕様:
//   POST https://api.line.me/oauth2/v2.1/verify
//     body: id_token=<ID_TOKEN>&client_id=<LIFF_CHANNEL_ID>
//     成功時のレスポンス: { iss, sub, aud, exp, iat, name?, email? }
//     sub が line_user_id (Uxxx)
//
// 環境変数:
//   LIFF_CHANNEL_ID         LINE Login Channel ID（数字）
//   LIFF_DEV_MOCK_USER_ID   開発時のみ。これが設定されていてかつ Bearer に
//                           "dev-mock" が来たら、検証なしで指定 user_id を使う

const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const VERIFY_TIMEOUT_MS = 5000;

function getDevMockUserId() {
  return (process.env.LIFF_DEV_MOCK_USER_ID || "").trim();
}

function getChannelId() {
  return (process.env.LIFF_CHANNEL_ID || "").trim();
}

/**
 * ID Token を検証して line_user_id を返す。
 * 失敗時は throw。
 */
async function verifyIdToken(idToken, expectedClientId) {
  if (!idToken) throw new Error("idToken is empty");
  const channelId = expectedClientId || getChannelId();
  if (!channelId) throw new Error("LIFF_CHANNEL_ID not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const body = new URLSearchParams();
    body.set("id_token", idToken);
    body.set("client_id", channelId);

    const res = await fetch(LINE_VERIFY_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        "LINE verify API returned " + res.status + ": " + text.slice(0, 200)
      );
    }
    const json = await res.json();
    if (!json || typeof json.sub !== "string") {
      throw new Error("verify response missing sub: " + JSON.stringify(json).slice(0, 200));
    }
    if (json.aud !== channelId) {
      throw new Error("aud mismatch: expected " + channelId + ", got " + json.aud);
    }
    return {
      lineUserId: json.sub,
      audience: json.aud,
      issuer: json.iss,
      expiresAt: json.exp,
      raw: json,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Express ミドルウェア。
 *   - 通常: Authorization: Bearer <ID_TOKEN> を verify → req.lineUserId
 *   - 開発: Authorization: Bearer dev-mock かつ LIFF_DEV_MOCK_USER_ID 設定なら
 *           検証スキップして req.lineUserId = LIFF_DEV_MOCK_USER_ID
 *   - 失敗: 401 を返す
 */
async function liffAuthMiddleware(req, res, next) {
  const auth = req.get("Authorization") || req.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({
      ok: false,
      error: "missing Bearer token",
    });
  }
  const token = auth.slice(7).trim();
  if (!token) {
    return res.status(401).json({ ok: false, error: "empty Bearer token" });
  }

  // 開発モック
  const mockUserId = getDevMockUserId();
  if (token === "dev-mock") {
    if (!mockUserId) {
      return res.status(503).json({
        ok: false,
        error: "dev-mock token used but LIFF_DEV_MOCK_USER_ID not set",
      });
    }
    req.lineUserId = mockUserId;
    return next();
  }

  // 本番: ID Token 検証
  if (!getChannelId()) {
    return res.status(503).json({
      ok: false,
      error: "LIFF_CHANNEL_ID not configured on server",
    });
  }
  try {
    const r = await verifyIdToken(token);
    req.lineUserId = r.lineUserId;
    next();
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: "ID token verification failed: " +
        ((err && err.message) || String(err)).slice(0, 200),
    });
  }
}

module.exports = {
  verifyIdToken,
  liffAuthMiddleware,
  // テスト用
  getChannelId,
  getDevMockUserId,
};
