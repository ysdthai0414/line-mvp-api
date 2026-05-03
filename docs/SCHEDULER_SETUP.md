# 週1配信スケジューラ セットアップ手順 (A1)

毎週決まった曜日・時刻に `run-delivery.js` を自動実行するための運用手順。

## アーキテクチャ

```
[GitHub Actions cron] (.github/workflows/weekly-delivery.yml)
  毎週月曜 09:00 JST に発火
        ↓ HTTP POST + X-Admin-Token
[App Service]   POST /admin/run-delivery  (index.js)
        ↓
[delivery_runner.runDelivery()]
  ├─ Users(state=CONFIRMED) を抽出
  ├─ 各ユーザーで recommendForUser
  ├─ buildDeliveryCarouselFlex で Flex 生成
  ├─ pushMessage（500ms間隔）
  └─ DeliveryLog に記録
        ↓
  JSON で結果サマリ返却
```

## 1. ADMIN_TOKEN を生成

長いランダム文字列を作る。例:

```bash
# Windows PowerShell
[Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")

# または OpenSSL（git Bash 等）
openssl rand -hex 32
```

得られた値（例: `8d4c91e5fa0c4831b9f6a2d77e0f5d3c8d4c91e5fa0c4831b9f6a2d77e0f5d3c`）を控える。

## 2. App Service 側に環境変数を設定

Azure Portal で App Service `tech0-gen-11-step4-node-3` を開き、**設定 → 環境変数 → アプリケーション設定** から `ADMIN_TOKEN` を上で生成した値で追加する。

> 値が設定されていないと `/admin/run-delivery` は 503 を返して安全に無効化される。

設定後、**「保存」をクリック → サービスが再起動**するまで数十秒待つ。

## 3. GitHub Secrets を設定

GitHub のリポジトリ画面で **Settings → Secrets and variables → Actions → New repository secret** で以下2つを登録：

| Name | Value |
| --- | --- |
| `APP_SERVICE_URL` | `https://tech0-gen-11-step4-node-3.azurewebsites.net` |
| `ADMIN_TOKEN` | 上で生成した値（App Service と同じもの） |

## 4. ワークフローを有効化

`.github/workflows/weekly-delivery.yml` を `main` にマージすると、GitHub が自動で cron を有効化する。

スケジュール: `cron: "0 0 * * 1"` = 月曜 00:00 UTC = **月曜 09:00 JST**。

> 曜日や時刻を変えたい場合は YAML の `cron:` を編集してマージ。

## 5. 動作確認（手動トリガー）

### 5-1. GitHub UI から手動実行

GitHub の **Actions タブ → Weekly Delivery → Run workflow** を押す。
入力欄で `dry_run: true` を指定すれば、LINE 送信せずペイロード確認のみ。

### 5-2. PowerShell からエンドポイントを直接叩く

```powershell
$url    = "https://tech0-gen-11-step4-node-3.azurewebsites.net/admin/run-delivery"
$token  = "<ADMIN_TOKEN を貼る>"
$body   = '{"dryRun": true, "limit": 3}'
Invoke-WebRequest -Uri $url -Method POST `
  -Headers @{ "X-Admin-Token" = $token; "Content-Type" = "application/json" } `
  -Body $body
```

期待レスポンス例（dryRun=true）:

```json
{
  "ok": true,
  "mode": "dry_run",
  "total": 3,
  "sent": 0,
  "skipped": 3,
  "failed": 0,
  "results": [
    { "lineUserId": "Uxxx", "status": "dry_run", "titles": ["..."] }
  ]
}
```

## 6. 失敗時のトラブルシュート

| HTTP | 意味 | 対応 |
| --- | --- | --- |
| 401 | X-Admin-Token 不一致 | `ADMIN_TOKEN` が App Service / Secrets で同一か再確認 |
| 503 | App Service 側の `ADMIN_TOKEN` 未設定 | Azure Portal で環境変数を追加し再起動 |
| 500 | サーバ内部エラー | App Service のログストリームで詳細確認 |
| 504 | タイムアウト | ユーザー数が多い場合あり。`limit` を下げるか `userId` 指定で分割実行 |

## 7. 監視

- **GitHub Actions の `Actions` タブ** から実行履歴・成否が見られる
- **App Service の「ログストリーム」** で `[delivery]` で始まるログを追える
- 失敗ユーザーは `result.results[].status === "failed"` で個別に把握可能

## 8. 切替・廃止

- 一時停止したい場合: GitHub の **Actions タブ → Weekly Delivery → ⋯ → Disable workflow**
- スケジュール変更: YAML の `cron:` を編集してマージ
- 本番から切り離したい場合: App Service の `ADMIN_TOKEN` を空にすれば即 503 で全拒否
