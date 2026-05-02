# 100億宣言支援AI - 引き継ぎ資料

最終更新: 2026-04-26
作成者: 吉田 + AI伴走

---

## 1. このプロダクトは何か

100億宣言の認可済企業（約3,135社）が **売上100億円達成を目指す** のを支援する LINE Bot。

支援は2系統:

1. **取り組み事例の月1配信**
   - ユーザー企業より売上フェーズが進んだ認可企業の取り組みを、業界・経営テーマの近さでレコメンドして配信
2. **オンライン相談会型マッチング**
   - 配信中の事例で「この会社の話を聞きたい」を表明 → オファーを集約 → N件以上集まったら事務局が相談会を企画 → 1対多の対話の場を作る

インターフェースは LINE 公式アカウントを主軸。将来的にマッチング画面は LIFF or Web を想定。

---

## 2. 今日までに完成したもの（オンボーディング機能）

### 動作する状態

- [x] LINE 友だち追加 → ようこそメッセージ
- [x] テキスト「会社名 + URL」を受信
- [x] 認可済企業マスタ（3,135件）と照合
  - 該当: 「処理中…」→ サイトをfetch→ Claude APIでプロファイル生成→ Flex Messageで確認
  - 不該当: お断りメッセージ + 事務局問い合わせ案内
- [x] 「これでOK」postback → DB確定保存
- [x] 「やり直す」postback → state リセット → 再入力

### コード／インフラの構成

| レイヤー | 採用技術 |
| --- | --- |
| ランタイム | Node.js 18+ (Express) |
| LINE SDK | `@line/bot-sdk` v9 |
| AI | Claude API (`claude-sonnet-4-5`) |
| HTML パース | `cheerio` (会社サイトのfetch + 本文抽出) |
| DB | **Azure Database for MySQL Flexible Server**（クラス共有: `tech0-gen11-step4-class-4`）|
| DBドライバ | `mysql2/promise` |
| ローカル公開 | `ngrok` (実機テスト用、開発時のみ) |

### Azure リソース

- **MySQL サーバー**: `tech0-gen11-step4-class-4.mysql.database.azure.com`（既存利用）
  - データベース: `linemvp`
  - 管理者: `student`
  - ファイアウォール: 自分のクライアントIP + Azure内サービスを許可済み
- **App Service**: 未作成（次のスプリントで作成）

### DB スキーマ（3テーブル）

- `ApprovedCompanies` — 中小企業庁公開リスト 3,135 社
  - `corporate_number`（法人番号、UNIQUE）/ `company_name` / `company_name_normalized` / `prefecture` / `industry_major/minor` / `annual_sales`（円）/ `target_year` / `declaration_pdf_url`
- `Users` — LINEユーザーごとのオンボーディング状態
  - `state`: `NEW` / `AWAITING_CONFIRM` / `CONFIRMED` / `NOT_APPROVED`
  - `approved_company_id` / `sales_tier` / `annual_sales` / `pending_*`
- `Profiles` — 確定済みのプロファイル履歴（複数行可）

### ファイル一覧

```
.
├── index.js                              # Express + /webhook
├── src/
│   ├── handlers.js                       # follow / message / postback の振り分け
│   ├── onboarding.js                     # 会社名+URLパース + 認可マッチ + プロファイル生成
│   ├── match.js                          # 会社名正規化 / URLドメイン抽出
│   ├── scraper.js                        # 会社サイト fetch & 本文抽出 (cheerio)
│   ├── ai.js                             # Claude API でプロファイル生成
│   ├── flex.js                           # 確認用 Flex Message テンプレート
│   └── db.js                             # MySQL 接続 & CRUD (mysql2)
├── scripts/
│   └── import-approved-companies.js      # 100億宣言企業一覧 (xlsx) → ApprovedCompanies 取り込み
├── db/
│   └── schema.sql                        # MySQL DDL（3テーブル）
├── .env.example                          # 環境変数の雛形
├── .gitignore
├── package.json
├── README.md                             # プロジェクト概要
├── ROADMAP.md                            # 全体ロードマップ（Phase 0 〜 6）
├── DEPLOY.md                             # Azure App Service デプロイ手順
├── AZURE_SETUP.md                        # Azure ポータルでのインフラセットアップ手順
└── HANDOVER.md                           # このファイル
```

---

## 3. 開発環境セットアップ手順（チームメンバー向け）

新しく入った人がローカルで動かすまでの手順。

### 前提

- Windows 10/11 / Mac いずれかで OK
- Node.js 18+ インストール済み
- VS Code（推奨）
- Git でこのリポジトリを clone 済み

### 0. 接続情報を吉田から受け取る

下記の値は秘密情報。Slack DM 等で共有してもらう:

| 名前 | 用途 |
| --- | --- |
| `MYSQL_PASSWORD` | Azure MySQL 接続パスワード |
| `LINE_CHANNEL_SECRET` | LINE Webhook 署名検証 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API |
| `ANTHROPIC_API_KEY` | Claude API キー |

ホスト名等の公開情報は `.env.example` に書いてある。

### 1. 依存関係インストール

```powershell
cd line-mvp-api
npm install
```

### 2. `.env` ファイル作成

`.env.example` をコピーして `.env` を作り、上記の秘密値を埋める。

> **注意**: VS Code で開いて、右下のエンコーディングが `UTF-8` であることを確認（BOM付きやUTF-16はNG、Notepadは使わない）。

### 3. Azure MySQL 接続確認

ファイアウォールで自分のクライアントIPを許可してもらう必要があります（吉田に伝えてください）。
許可してもらったら:

```powershell
node -e "require('dotenv').config(); const m=require('mysql2/promise'); m.createPool({host:process.env.MYSQL_HOST,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE,ssl:{rejectUnauthorized:false}}).execute('SELECT COUNT(*) AS n FROM ApprovedCompanies').then(r=>console.log(r[0]))"
```

→ `[ { n: 3135 } ]` が返ればOK。

### 4. ローカル起動

```powershell
npm start
```

→ `Server running on port 8080` が出ればOK。

### 5. ngrok でトンネル（LINE実機テストする場合のみ）

ngrok を winget でインストール:
```powershell
winget install ngrok.ngrok
```
（npm経由はバージョンが古くてハマるので避ける）

サインアップ→ authtoken を取得（<https://dashboard.ngrok.com>）:
```powershell
ngrok config add-authtoken （自分のトークン）
ngrok http 8080
```

→ 表示された `https://xxx.ngrok-free.app` を LINE Developers Console の Webhook URL に設定（`/webhook` 末尾を忘れずに）して Verify。

> ⚠️ 開発用の LINE チャネルを共有して使う場合、誰かがWebhook URLを差し替えるとほかの人の作業が止まります。**チャネルを複数作る** か、**作業時間を分ける** かルールを決めましょう。

---

## 4. オンボーディング機能の挙動

### 会話フロー

```
[ユーザー] 友だち追加
[Bot]     ようこそメッセージ + 会社名+URLを送ってと案内

[ユーザー] 株式会社○○
          https://example.co.jp

[Bot]     「処理中…」テキスト
          ↓ サーバー裏でサイトfetch + Claude実行（約10〜30秒）
[Bot]     Flex カード（事業内容/業界タグ/経営テーマ/学びたい領域/強み + OKボタン/やり直しボタン）

[ユーザー] 「これでOK」をタップ
[Bot]     確定メッセージ「月1配信が始まります」

[ユーザー] 「やり直す」をタップ
[Bot]     再入力を促すメッセージ
```

### 認可マッチの仕様

- 会社名を `normalizeCompanyName()` で正規化（株式会社/(株)/㈱/全角空白等を除去）
- `ApprovedCompanies.company_name_normalized` と完全一致で検索
- 0件 → `state='NOT_APPROVED'` 記録 + お断り
- 1件 → 認可OK → AIプロファイル生成へ
- 2件以上（同名社が併存、全3,135件中15ペア確認済み）→ 暫定で先頭採用 + ログ警告。Phase 0で都道府県確認フローを追加予定（タスク#23）

### 売上フェーズ区分

| `sales_tier` | 売上 |
| --- | --- |
| `UNDER_10` | 〜10億円 |
| `10_30` | 10〜30億円 |
| `30_50` | 30〜50億円 |
| `50_100` | 50〜100億円 |
| `OVER_100` | 100億円以上 |

---

## 5. これからやること（タスクリスト）

優先度・依存関係順。

### スプリント1の残り（Phase 0 仕上げ）

| # | タスク | 概要 | 担当候補 |
| --- | --- | --- | --- |
| 21 | LINE Webhook URL を本番に切替 + Verify | App Service 立てた後、本番URLに差し替え | 吉田 |
| 22 | 実機でフルオンボーディング動作確認 | スマホで一連のフロー確認、必要に応じて文言調整 | 吉田 |
| 23 | 同名衝突 → 都道府県確認フロー実装 | `AWAITING_PREFECTURE` state 追加、Quick Reply で都道府県選択 | 開発担当 |
| 24 | リッチメニュー設計と適用 | 「マイプロファイル / 配信履歴 / 話を聞きたい一覧 / 設定」の4ボタン | 開発担当（設計） + 吉田（LINE OA Mgr適用） |
| 新 | Azure App Service へデプロイ | DEPLOY.md 参照。ngrok から本番URL運用へ移行 | 開発担当 |

### スプリント2（Phase 1 + 2、〜3週間）

| 区分 | 内容 |
| --- | --- |
| Phase 1 | `Initiatives`（取り組み事例）テーブル設計と DDL 追加 |
| Phase 1 | 宣言PDFを取得 → Claude で構造化要約するバッチ作成（半自動） |
| Phase 1 | 抽出結果は `status='draft'` で保存、事務局レビュー後に `published` |
| Phase 2 | 月1配信スケジューラ（Azure Functions Timer Trigger 推奨） |
| Phase 2 | レコメンド: ユーザーの `sales_tier` より上 + `industry_tags`/`management_themes` 重なり度 |
| Phase 2 | Flex Message Carousel で3件提示 |
| Phase 2 | `DeliveryLog` （重複配信防止）+ `DeliveryFeedback` （postbackで反応回収） |

### スプリント3（Phase 3、〜4週間）

| 区分 | 内容 |
| --- | --- |
| Phase 3a | 配信カードに「話を聞きたい」postback ボタン |
| Phase 3a | `MatchingRequests` テーブル + 集約ロジック |
| Phase 3b | 事務局通知（メール/Slack）と `ConsultationEvents` 作成フロー |
| Phase 3b | 参加表明・キャンセル・リマインド・アーカイブ配信 |
| Phase 5 | 事務局向け簡易管理画面（事例レビュー & 申請対応） |

### スプリント4以降

- Phase 4: LIFF アプリ（マッチング体験の拡張）
- Phase 5: 事務局運用ツール（事例登録UI、KPIダッシュボード）
- Phase 6: 配信フィードバックを使ったレコメンド改善 / プロファイル更新フロー

詳しくは `ROADMAP.md` 参照。

---

## 6. 知っておいたほうがいいこと

### コード規約・癖

- ファイルは UTF-8（BOMなし）。**Windows Notepad は使わないで** ください（BOM付きやUTF-16で保存される事故多発）。VS Code 推奨。
- `.env` を絶対 git に commit しない（`.gitignore` で除外済み）。
- `node_modules/` は OneDrive 同期下にあると壊れます（実体験済）。長期的にはプロジェクトを `C:\dev\` 等 OneDrive 外に移動推奨。
- Anthropic API は使うたび課金されるので、テスト時は呼び出し回数を意識（プロファイル生成1回 ≒ $0.01〜0.03 前後）。

### 既知の制約

- 認可リストの同名社が15ペアあり、暫定で先頭採用。タスク#23 で対応予定。
- ngrok 無料プランはセッション毎にURLが変わる。実機テスト中は LINE Webhook URL の差し替えが要る → だから **Phase 0 の最後に App Service にデプロイして固定URL化** したい。
- App Service の B1 プラン（最安）はコールドスタートあり。MVP検証フェーズはOKだが、本格運用ならスケール検討。

### コスト感

- Azure MySQL: クラス共有のため当面 ¥0
- Azure App Service B1: 月 ¥1,500 程度（B1 プランで Always On 有効化）
- Anthropic API: ユーザー1人のオンボーディングで $0.01〜0.03。100社使ってもMVP検証中は月数百円〜千円程度
- LINE Messaging API: 月1,000通までフリー（無料プラン）

---

## 7. 参考資料・関連リンク

| ドキュメント | 用途 |
| --- | --- |
| [README.md](./README.md) | プロジェクト概要 |
| [ROADMAP.md](./ROADMAP.md) | 全体ロードマップ（Phase 0〜6） |
| [DEPLOY.md](./DEPLOY.md) | Azure App Service デプロイ手順（CLI主体） |
| [AZURE_SETUP.md](./AZURE_SETUP.md) | Azureポータル操作手順（GUI主体） |

| 外部リンク | 用途 |
| --- | --- |
| <https://dashboard.ngrok.com> | ngrok 設定（authtoken） |
| <https://console.anthropic.com> | Claude API キー発行・残高確認 |
| <https://developers.line.biz/console/> | LINE チャネル設定 |
| <https://growth-100-oku.smrj.go.jp/> | 100億宣言公式サイト |
| <https://portal.azure.com> | Azure リソース管理 |

---

## 8. 困ったときの問い合わせ

- インフラ系（Azure / MySQL / LINE 鍵）→ 吉田
- コード系（コミット履歴・実装意図）→ コードコメント or 吉田に聞く

