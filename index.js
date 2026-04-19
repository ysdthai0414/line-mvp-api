const express = require("express");
const { messagingApi, middleware } = require("@line/bot-sdk");

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
app.post("/webhook", middleware(config), (req, res) => {
  const events = req.body.events;

  const results = events.map((event) => {
    // 友だち追加時
    if (event.type === "follow") {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: "ようこそ「100億宣言支援AI」へ！\n\nまずは御社名と会社サイトのURLを教えてください。\n\n例：\n株式会社○○\nhttps://example.co.jp",
          },
        ],
      });
    }

    // テキストメッセージ受信時
    if (event.type === "message" && event.message.type === "text") {
      const userText = event.message.text;
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: `受け取りました：\n「${userText}」\n\n（※現在MVP開発中です。今後AIがプロファイルを自動生成します）`,
          },
        ],
      });
    }

    return Promise.resolve(null);
  });

  Promise.all(results)
    .then(() => res.json({ success: true }))
    .catch((err) => {
      console.error("Error:", err);
      res.status(500).json({ error: err.message });
    });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
