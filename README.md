# 100億宣言支援AI - LINE MVP API

LINE 公式アカウントの Webhook サーバ。
オンボーディングは「100億宣言の認可済企業」のみ受付け、
ユーザーが送った会社名+URLを認可リスト（中小企業庁公開）と照合し、
Claude API で初期プロファイルを生成して Flex Message で確認してもらう。

## ファイル構成

```
.
├── index.js                              # Express サーバ + /webhook エントリポイント
├── src/
│   ├── handlers.js                       # follow / message / postback の振り分け
│   ├── onboarding.js                     # 会社名+URLパース + 認可マッチ + プロファイル生成
│   ├── match.js                          # 会社名正規化 / URLドメイン抽出
│   ├── scraper.js                        # 会社サイト fetch & 本文抽出 (cheerio)
│   ├── ai.js                             # Claude API でプロファイル生成
│   ├── flex.js                           # 確認用 Flex Message テンプレート
│   └── db.js                             # Azure MySQL 接続 & CRUD (mysql2)
├── scripts/
│   └── import-approved-companies.js      # 100億宣言企業一覧 (xlsx) → ApprovedCompanies
├── db/
│   └── schema.sql                        # Azure MySQL DDL (3テーブル)
├── .env.example                          # 必要な環境変数の雛形
└── package.json
```

## 必要な環境変数

`.env.example` を参照。

| 変数 | 用途 |
| --- | --- |
| `LINE_CHANNEL_SECRET` | LINE Webhook の署名検証 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API |
| `ANTHROPIC_API_KEY` | Claude API キー |
| `ANTHROPIC_MODEL` | 任意。デフォルト `claude-sonnet-4-5` |
| `AZURE_SQL_SERVER` | 例 `xxx.database.windows.net` |
| `AZURE_SQL_DATABASE` | DB 名 |
| `AZURE_SQL_USER` / `AZURE_SQL_PASSWORD` | SQL 認証 |
| `AZURE_SQL_PORT` | 任意。デフォルト 1433 |
| `AZURE_SQL_ENCRYPT` | 任意。デフォルト `true` |

## 初回セットアップ

```bash
npm install

# 1) Azure SQL に DDL を流す
sqlcmd -S "$AZURE_SQL_SERVER" -d "$AZURE_SQL_DATABASE" \
       -U "$AZURE_SQL_USER" -P "$AZURE_SQL_PASSWORD" \
       -i db/schema.sql

# 2) 100億宣言企業一覧 (xlsx) を ApprovedCompanies に取り込む
#    法人番号がユニークキー。同じファイルを再実行すると upsert される。
npm run import:approved -- ./sengenkigyoichiran_20260420.xlsx
```

## 起動

```bash
npm start
# → :8080 で listen
```

`POST /webhook` を LINE Developers コンソールに登録すれば疎通完了。

## 認可マッチの仕様

- ユーザーが「会社名 + URL」を送る → 会社名を `normalizeCompanyName()` で正規化（株式会社/(株)/㈱/全角空白などを除去）
- `ApprovedCompanies.company_name_normalized` と完全一致で検索
- 0件 → `state='NOT_APPROVED'` を記録 + 事務局に問い合わせる旨をテキストで返信
- 1件 → 認可OK。売上高（億円→円）から `sales_tier` を判定し、Claude にプロファイル生成を依頼
- 2件以上（同名社が認可リストに併存）→ 暫定で先頭を採用しつつ `console.warn` でログ。後で都道府県/法人番号で絞る運用が必要

## 会話フロー

1. **友だち追加** → ようこそメッセージ + 会社名+URL を要求
2. **テキスト受信** → パース → `ApprovedCompanies` で照合
   - 認可なし: お断りメッセージ（事務局に問い合わせを案内）
   - 認可あり: 「処理中…」テキスト + ローディングアニメーション
3. サイトを fetch → Claude でプロファイル JSON 生成 → DB に pending 保存
4. Flex Message を push（売上フェーズ + 業界タグ + 経営テーマ + 学びたい領域 + 強み + 「これでOK」/「やり直す」）
5. **postback `action=confirm`** → `Profiles` に確定 + 「月1配信が始まります」
6. **postback `action=retry`** → pending を破棄 → 入力からやり直し

## 売上フェーズ区分（暫定）

| `sales_tier` | 売上 |
| --- | --- |
| `UNDER_10` | 〜10億円 |
| `10_30` | 10〜30億円 |
| `30_50` | 30〜50億円 |
| `50_100` | 50〜100億円 |
| `OVER_100` | 100億円以上 |

配信機能は「自分より大きい tier の認可企業の取り組み」を月1で配信する設計を想定。

## 動作確認手順（ローカル）

`ngrok` などで Webhook を公開し、LINE Developers コンソールで Webhook URL を差し替える。

1. ボットを友だち追加 → ようこそメッセージが返る
2. 認可済企業の名前+URLを送信:
   ```
   コーリョー建販株式会社
   https://www.koryo-kenpan.co.jp
   ```
   → 数十秒後に Flex カードが届く
3. 認可されていない適当な会社名を送信 → お断りメッセージが返る
4. 「これでOK」→ 確定 / 「やり直す」→ 入力からやり直し
5. Azure SQL で確認:
   ```sql
   SELECT * FROM dbo.Users;
   SELECT * FROM dbo.Profiles;
   SELECT TOP 5 * FROM dbo.ApprovedCompanies;
   ```

## 構文チェック

```bash
npm run check
```

## 次のマイルストーン候補

- 月1配信スケジューラ（Azure Functions Timer Trigger or Cloud Scheduler + Cloud Run）
- 「この会社の話を聞きたい」ボタン → マッチング申請レコード作成 → 事務局向け通知
- マッチング画面 (LIFF アプリ) — 認可企業の取り組み一覧、検索、面談オファー
- 同名衝突への対応（都道府県確認 or 法人番号入力プロンプト）
