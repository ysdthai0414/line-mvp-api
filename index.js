// .env をロード（ローカル開発用、App Service 等の本番では設定済の環境変数を使うので no-op）
try { require("dotenv").config(); } catch (_e) { /* dotenv 未インストールでも動く */ }

const express = require("express");
const { messagingApi, middleware } = require("@line/bot-sdk");
const { handleEvent } = require("./src/handlers");

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const clientConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new messagingApi.MessagingApiClient(clientConfig);
const app = express();

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
      }
    })
  );

  res.json({ success: true });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
