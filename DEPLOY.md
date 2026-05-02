# Azure App Service デプロイ手順

LINE MVP API を Azure App Service (Linux / Node 18+) にデプロイする手順。
Azure SQL は作成済み・接続情報を取得済みである前提。

## 0. 用意するもの

- Azure サブスクリプション
- Azure CLI（`az`）が入った端末（または Azure Portal）
- LINE Channel Secret / Channel Access Token
- Anthropic API Key
- Azure SQL の Server / Database / User / Password

## 1. Azure リソース作成（CLI）

リージョン・名前は適宜変更してください。

```bash
# 変数設定（自分の値に置き換え）
RG=line-mvp-rg
LOCATION=japaneast
PLAN=line-mvp-plan
APP=line-mvp-api          # 全Azureで一意。.azurewebsites.net のサブドメインになる
SQL_SERVER=xxx.database.windows.net
SQL_DB=line_mvp
SQL_USER=xxx
SQL_PASS='xxx'

# 1-1. リソースグループ
az group create --name $RG --location $LOCATION

# 1-2. App Service Plan（Linux / 最小サイズはB1を推奨。F1でも動くがコールドスタートあり）
az appservice plan create \
  --name $PLAN --resource-group $RG \
  --is-linux --sku B1

# 1-3. Web App（Node 18 LTS）
az webapp create \
  --name $APP --resource-group $RG --plan $PLAN \
  --runtime "NODE:18-lts"

# 1-4. 起動コマンド（package.json の "start" が node index.js なので明示は不要だが念のため）
az webapp config set \
  --name $APP --resource-group $RG \
  --startup-file "node index.js"

# 1-5. 環境変数（App Settings）登録
az webapp config appsettings set \
  --name $APP --resource-group $RG \
  --settings \
    LINE_CHANNEL_SECRET='xxx' \
    LINE_CHANNEL_ACCESS_TOKEN='xxx' \
    ANTHROPIC_API_KEY='xxx' \
    ANTHROPIC_MODEL='claude-sonnet-4-5' \
    AZURE_SQL_SERVER="$SQL_SERVER" \
    AZURE_SQL_DATABASE="$SQL_DB" \
    AZURE_SQL_USER="$SQL_USER" \
    AZURE_SQL_PASSWORD="$SQL_PASS" \
    AZURE_SQL_ENCRYPT='true' \
    WEBSITES_PORT='8080' \
    SCM_DO_BUILD_DURING_DEPLOYMENT='true'
```

> **`SCM_DO_BUILD_DURING_DEPLOYMENT=true`** を入れると、デプロイ時に Kudu が
> `npm install --production` を自動実行します。
> **`WEBSITES_PORT=8080`** は Express がリッスンするポートと合わせます。

## 2. Azure SQL のファイアウォール許可

App Service から Azure SQL に接続できるよう、SQL サーバ側で許可設定。

```bash
SQL_SERVER_NAME=$(echo $SQL_SERVER | cut -d. -f1)

# 「Azureサービスからの接続を許可」
az sql server firewall-rule create \
  --resource-group $RG \
  --server $SQL_SERVER_NAME \
  --name AllowAzureServices \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
```

DDL を流す端末からも一時的に開けておく（自分のグローバルIPで）。

```bash
MY_IP=$(curl -s https://ifconfig.me)
az sql server firewall-rule create \
  --resource-group $RG \
  --server $SQL_SERVER_NAME \
  --name AllowMyIP \
  --start-ip-address $MY_IP --end-ip-address $MY_IP
```

## 3. DDL 適用

```bash
sqlcmd -S "$SQL_SERVER" -d "$SQL_DB" -U "$SQL_USER" -P "$SQL_PASS" -i db/schema.sql
```

## 4. 認可リスト取り込み

```bash
# .env をローカルに用意してから実行
npm install
npm run import:approved -- ./sengenkigyoichiran_20260420.xlsx
```

ローカルから直接 Azure SQL に upsert します（3,135件）。

## 5. アプリのデプロイ

最も簡単なのは ZIP デプロイ。

```bash
# node_modules / .git を含めずに ZIP を作る
zip -r app.zip . -x "node_modules/*" ".git/*" "*.zip"

# デプロイ
az webapp deploy \
  --name $APP --resource-group $RG \
  --src-path app.zip --type zip
```

> 上記で起動時に `npm install --production` が走り、依存をインストールしてから
> `node index.js` でサーバ起動。

代替: GitHub と連携する Continuous Deployment を設定すると `main` への push で自動デプロイされる。

## 6. ヘルスチェック

```bash
curl https://${APP}.azurewebsites.net/
# → "LINE MVP API is running!"
```

## 7. LINE Webhook URL 差し替え

LINE Developers Console で:

- **Webhook URL** = `https://${APP}.azurewebsites.net/webhook`
- **Webhookの利用** = ON
- **Verify** ボタンを押して `Success` になることを確認
- 応答メッセージ・あいさつメッセージは「無効」（このBotで返すため）

## 8. 実機テスト

スマホで:

1. 友だち追加 → ようこそメッセージが届く
2. 認可済企業の名前+URL を送る → Flex カードが届く
3. 「これでOK」/「やり直す」が動く

何か詰まったら `az webapp log tail --name $APP --resource-group $RG` でログを見る。

## トラブルシュート

| 症状 | 確認ポイント |
| --- | --- |
| 502 / 503 が返る | 起動失敗。ログを `az webapp log tail` で確認。`WEBSITES_PORT` と Express の listen ポートが一致しているか |
| Webhook Verify が失敗 | `LINE_CHANNEL_SECRET` 不一致、または HTTPS 証明書の問題（App Serviceは自動でTLS） |
| SQL 接続失敗 | App Service の Outbound IP が Azure SQL のファイアウォールで許可されていない / `AllowAzureServices` が無効 |
| `npm install` が走らない | `SCM_DO_BUILD_DURING_DEPLOYMENT=true` が入っているか確認 |

