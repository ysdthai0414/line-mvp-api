# エラー監視 セットアップ手順 (A3)

本番でエラーが起きたら誰かが気づく仕組み。3層構成。

## 全体像

```
[Layer 1] Azure Application Insights
   ・App Service の左メニュー「Application Insights」から1クリックで有効化
   ・コード変更不要、リクエスト/例外/レスポンス時間が自動収集
   ・ダッシュボードで全体傾向を把握、アラートも組める

[Layer 2] アプリケーション内エラー通知 (本リポジトリ実装)
   ・src/error_notifier.js が webhook / admin endpoint / 致命的例外を捕捉
   ・SLACK_WEBHOOK_URL 設定なら Slack 通知、未設定なら App Service ログに出力
   ・同じエラー指紋は ERROR_NOTIFY_WINDOW_SECONDS（既定5分）以内は1回だけ通知

[Layer 3] 死活監視 / ヘルスチェック
   ・GET /admin/health （X-Admin-Token 認証）で DB接続+環境変数を確認
   ・外部cron（GitHub Actions / UptimeRobot 等）から定期的に叩く
   ・503 が返ったら何かが壊れている → 通知
```

## Layer 1: Azure Application Insights

最も簡単で効果的なステップ。**Azure ポータルで1クリック**。

1. Azure Portal で App Service `tech0-gen-11-step4-node-3` を開く
2. 左メニューの **「Application Insights」** をクリック
3. **「Application Insights を有効にする」** ボタンを押す
4. 既存リソースを使うか、新規作成するか聞かれる → 新規作成（無料枠で十分）
5. 「適用」 → 数分で有効化
6. App Service が自動再起動して、以降の全リクエスト/例外が自動収集される

確認:
- 数分待った後、Application Insights のダッシュボードを開くと「ライブメトリック」「失敗」「パフォーマンス」が見える
- アラート: 左メニュー「アラート」→「アラートルールを作成」で「失敗したリクエスト > 5/min」等を設定可能

## Layer 2: アプリ内エラー通知

### 2-1. SLACK_WEBHOOK_URL を設定（任意だが推奨）

1. Slack の通知用チャンネルを決める（例: `#100okuapp-alerts`）
2. https://api.slack.com/messaging/webhooks で Incoming Webhook を作成
3. 取得した URL を Azure Portal の App Service 環境変数 `SLACK_WEBHOOK_URL` にセット
4. 保存して再起動

> 設定しなければコンソールに `[error_notifier]` で出力されるので、App Service のログストリームで拾える。

### 2-2. 重複抑制の調整（任意）

`ERROR_NOTIFY_WINDOW_SECONDS`（既定 300 秒 = 5 分）を環境変数で調整可能。
バースト的なエラーで Slack が埋まる場合は大きく、即時性を高めたい場合は小さく。

緊急停止（通知をオフに）したいときは `ERROR_NOTIFY_DISABLED=true` を一時設定すればよい。

### 2-3. 通知トリガー一覧

このアプリで自動通知される箇所:

| 発生箇所 | コンテキスト |
| --- | --- |
| `/webhook` のイベント処理失敗 | source=webhook, eventType, lineUserId 等 |
| `POST /admin/run-delivery` 失敗 | source=admin/run-delivery |
| Express 全体の未ハンドル例外 | source=express_unhandled |
| Node プロセスの unhandledRejection | source=process.unhandledRejection |
| Node プロセスの uncaughtException | source=process.uncaughtException（その後プロセス再起動） |

## Layer 3: 死活監視 / ヘルスチェック

### 3-1. エンドポイント仕様

```
GET /admin/health
Header: X-Admin-Token: <ADMIN_TOKEN>

レスポンス例（healthy）:
HTTP 200
{
  "ok": true,
  "status": "healthy",
  "checks": {
    "db":  { "ok": true, "detail": "SELECT 1 = 1" },
    "env": { "ok": true, "missing": [] }
  },
  "ts": "2026-05-03T..."
}

レスポンス例（degraded）:
HTTP 503
{
  "ok": false,
  "status": "degraded",
  "checks": {
    "db":  { "ok": false, "detail": "ECONNREFUSED ..." },
    "env": { "ok": true, "missing": [] }
  }
}
```

### 3-2. PowerShell から叩く例

```powershell
$url   = "https://tech0-gen-11-step4-node-3.azurewebsites.net/admin/health"
$token = "<ADMIN_TOKEN>"
Invoke-WebRequest -Uri $url -Method GET `
  -Headers @{ "X-Admin-Token" = $token } `
  | Select-Object -ExpandProperty Content
```

### 3-3. cron で定期チェック（GitHub Actions の例）

`.github/workflows/health-check.yml` を作成（次セッション以降のタスク）:

```yaml
name: Health Check
on:
  schedule:
    - cron: "*/15 * * * *"   # 15分おき
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: |
          STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
            -H "X-Admin-Token: ${{ secrets.ADMIN_TOKEN }}" \
            "${{ secrets.APP_SERVICE_URL }}/admin/health")
          if [ "$STATUS" != "200" ]; then
            echo "::error::Health check returned $STATUS"
            exit 1
          fi
```

失敗時は GitHub Actions のメール通知が飛ぶ（リポジトリ Settings → Notifications）。

## トラブルシュート

| 症状 | 原因の見当 | 対処 |
| --- | --- | --- |
| `/admin/health` が 401 | X-Admin-Token 不一致 | `ADMIN_TOKEN` を Azure / Secrets で再確認 |
| `/admin/health` が 503 で `db.ok: false` | DB 接続失敗 | Azure Portal で Azure MySQL の状態確認、FW、認証情報 |
| `/admin/health` が 503 で `env.missing` あり | 必須環境変数欠落 | App Service 環境変数を見直し再起動 |
| Slack に通知が来ない | `SLACK_WEBHOOK_URL` 未設定 or Webhook 切れ | App Service ログで `[error_notifier]` 行を探す |
| 同じエラーが大量に Slack に来る | 重複抑制窓が短すぎ | `ERROR_NOTIFY_WINDOW_SECONDS` を 600 等に |

## 運用初期のチェックリスト

- [ ] Application Insights 有効化（Azure Portal）
- [ ] `ADMIN_TOKEN` 設定（A1 と共通）
- [ ] `SLACK_WEBHOOK_URL` 設定（推奨）
- [ ] PowerShell で `/admin/health` が 200 を返すことを確認
- [ ] わざとエラーを起こして Slack に届くことを確認（例: 一時的に DB認証情報を破壊→ヘルスチェック叩く→直す）
- [ ] GitHub Actions でヘルスチェック cron を仕込む（任意）
