# 100億宣言支援AI - 引き継ぎ資料

最終更新: 2026-05-03（永岡セッションでの追記あり）
作成者: 吉田 + AI伴走 / 2026-05-03 追記: 永岡

> **2026-05-03 更新の要点**
> - **Phase 0 #23（同名衝突→都道府県QR）が完了**。22項目の自動テスト全パス、ローカルにcommit `83dbe7f` 保持。push は権限不足で保留中。
> - **#24 リッチメニュー（4ボタン）開発側の作業が完了**。LINE API 連携スクリプト、4種postback応答、SVG雛形まで。18項目テスト全パス。本番投入は画像PNG生成 + setup-rich-menu.js 実行のみ。
> - **Phase 1 のコア（宣言PDF→Claude→Initiatives draft 保存バッチ）が完成**。1社で実Claude動作確認済み（id=19、株式会社大和）。
> - **Phase 2 配信フローのE2Eが結合テストで実証**（status gating、スコアリング、match reasons の動作確認、8項目テスト全パス）。
> - **Phase 3a マッチングしきい値検知 + 事務局通知が完成**。Slack Webhook対応、コンソールfallback、重複通知抑制、履歴記録、15項目テスト全パス。`db/schema_v5.sql` 適用済み。
> - **Phase 3b-1 相談会の最小骨格（事務局向けCLI）が完成**。`ConsultationEvents` / `ConsultationParticipants` 2テーブル、`scripts/create-consultation.js` の7サブコマンド、24項目テスト全パス。`db/schema_v6.sql` 適用済み。
> - **Phase 3b-2 参加打診push + 参加表明postback が完成**。`buildConsultationInviteFlex`、push バッチ、`action=consult` postback ハンドラ、21項目テスト全パス。`db/schema_v7.sql` 適用済み。マッチング→参加表明のユーザー側ループが繋がった。
> - **Phase 3b-3 リマインド送信 + アーカイブ配信が完成**。`buildConsultationReminderFlex`/`buildConsultationArchiveFlex`、統合バッチ `run-consultation-reminders.js`（`--mode reminder|archive|both`）、28項目テスト全パス。`db/schema_v8.sql` 適用済み。**マッチングループの全ステップ（配信→申請→集約→通知→招待→打診→参加→開催→アーカイブ）が端から端までコード化された**。
> - **Phase 6 配信フィードバック→レコメンド改善が完成**。`getCategoryFeedbackBias` で過去 helpful/not_helpful の category 単位累計を集計し、`recommend.js` のスコアに反映。25項目テスト全パス（seed Initiative にもクロスカット適用される検証含む）。DDL 変更なし。
> - **A1 週1配信スケジューラが完成**。`src/delivery_runner.js` でコアロジックを関数化、`POST /admin/run-delivery` エンドポイント追加（X-Admin-Token 認証）、GitHub Actions cron `.github/workflows/weekly-delivery.yml`（月曜09:00 JST、手動実行対応）、運用手順書 `docs/SCHEDULER_SETUP.md`、14項目テスト全パス。本番投入は `ADMIN_TOKEN` を Azure環境変数 + GitHub Secrets に設定するだけ。
> - **A3 エラー監視が完成**。`src/error_notifier.js` で Slack/コンソール通知 + 同一エラー指紋の重複抑制（既定5分窓）、`GET /admin/health` で DB+環境変数の死活確認、Express/process全レベルでの未ハンドル例外捕捉、運用手順書 `docs/MONITORING_SETUP.md`（3層構成: Application Insights / アプリ内通知 / ヘルスチェック）、27項目テスト全パス。
> - **優先度A（本番運用に必須）の3項目すべて完了**。MVP本番投入のブロッカーが消えた。
> - **D1 Claude動的推薦理由生成が完成**。`src/reason_ai.js` でユーザーprofile + 過去feedback + 一致業界/テーマを Claude に渡し、配信時の「あなたへ」テキストを動的生成。`buildReasonText` が `_dynamicReason` を優先表示、無ければ既存の静的テンプレにフォールバック。`REASON_AI_DISABLED` で緊急停止可能。12項目テスト全パス、既存テストへの影響なし。
> - **B3 LIFF配信履歴アプリが完成**。`src/liff_auth.js` で LINE verify API を使った ID Token 検証 + 開発用 dev-mock モード、`GET /api/me/deliveries` で直近30件の配信履歴を返却、`public/liff/history.html` で LIFF アプリ本体（カード形式UI）、運用手順 `docs/LIFF_SETUP.md`。19項目テスト全パス。本番投入は LIFF Channel 発行 + `LIFF_CHANNEL_ID` 設定 + リッチメニュー連携のみ。
> - **優先度B（体験向上）の3項目すべて完了**。
> - **D2 協調フィルタリングが完成**。`getCollaborativeScores` で「自分と最低1件 helpful が共通の類似ユーザー集団」が helpful にした事例を集計し、`recommend.js` のスコアに `collab × 1.5`（上限5でcap）を加算。Phase 6（単独学習）と組み合わせて、新規ユーザーでも類似ユーザーの傾向を借りて精度向上。19項目テスト全パス、DDL変更なし。
> - **優先度D（拡張）の2項目すべて完了**。
> - **「これからやってほしいこと」の永岡担当タスクすべて完了**（C1 外注 / C2 DB移行待ち を除く）。
> - 累計自動テスト **252項目**、すべて pass。
> - 詳細は `SESSION_NOTES_2026-05-03.md` を参照。

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

### ファイル一覧（2026-05-03 時点）

```
.
├── index.js                              # Express + /webhook
├── src/
│   ├── handlers.js                       # follow / message / postback の振り分け
│   │                                       # ★ 2026-05-03: AWAITING_PREFECTURE 対応 / runProfileGeneration 切り出し
│   ├── onboarding.js                     # 会社名+URLパース + 認可マッチ + プロファイル生成
│   │                                       # ★ 2026-05-03: resolveByPrefecture / uniquePrefectures 追加
│   ├── match.js                          # 会社名正規化 / URLドメイン抽出
│   ├── scraper.js                        # 会社サイト fetch & 本文抽出 (cheerio)
│   ├── ai.js                             # Claude API でユーザープロファイル生成（オンボ用）
│   ├── flex.js                           # Flex Message / Quick Reply テンプレート
│   │                                       # ★ 2026-05-03: buildPrefectureQuickReply 追加
│   ├── db.js                             # MySQL 接続 & CRUD (mysql2)
│   │                                       # ★ 2026-05-03: 都道府県絞り込み / saveAwaitingPrefecture / getPendingCompanyInput
│   ├── recommend.js                      # 配信候補のスコアリング（Phase 2-3）
│   ├── matching.js                       # 「話を聞きたい」のDB操作（Phase 3a）
│   │                                       # ★ 2026-05-03: findCompaniesAboveThreshold / wasNotifiedRecently / recordNotification 追加
│   ├── categories.js                     # 8カテゴリ + Quick Reply ビルダー
│   ├── pdf.js                            # ★ NEW 2026-05-03: 宣言PDF取得+テキスト抽出 (pdf-parse)
│   ├── initiative_ai.js                  # ★ NEW 2026-05-03: Claude で取り組み事例の構造化抽出
│   ├── notify.js                         # ★ NEW 2026-05-03: Slack Webhook + コンソール fallback
│   ├── menu_handlers.js                  # ★ NEW 2026-05-03: リッチメニュー4ボタン応答 (#24)
│   ├── consultation.js                   # ★ NEW 2026-05-03: 相談会CRUD + 参加者管理 + push用関数 (Phase 3b-1/2/3)
│   ├── delivery_runner.js                # ★ NEW 2026-05-03: 配信コアロジック関数化 (A1, HTTP/CLI共通)
│   ├── error_notifier.js                 # ★ NEW 2026-05-03: エラー通知 + 重複抑制 (A3)
│   ├── reason_ai.js                      # ★ NEW 2026-05-03: Claude動的推薦理由生成 (D1)
│   └── liff_auth.js                      # ★ NEW 2026-05-03: LIFF ID Token 検証 (B3)
├── scripts/
│   ├── import-approved-companies.js      # 認可企業マスタ取り込み
│   ├── run-delivery.js                   # 月1配信実行（CLI、Azure Functions Timer等から呼ぶ想定）
│   ├── run-sql.js                        # 任意SQLファイル実行ユーティリティ
│   │                                       # ★ 2026-05-03: BOM対応 + 単文SELECT表示対応
│   ├── import-initiatives.js             # ★ NEW 2026-05-03: 宣言PDF → Claude → Initiatives draft 投入
│   ├── test-prefecture-flow.js           # ★ NEW 2026-05-03: 同名衝突フロー結合テスト（22項目）
│   ├── test-delivery-recommendation.js   # ★ NEW 2026-05-03: 配信レコメンド結合テスト（8項目）
│   ├── check-matching-threshold.js       # ★ NEW 2026-05-03: マッチングしきい値検知バッチ
│   ├── test-matching-threshold.js        # ★ NEW 2026-05-03: しきい値+通知 結合テスト（15項目）
│   ├── setup-rich-menu.js                # ★ NEW 2026-05-03: LINE リッチメニュー作成・適用 (#24)
│   ├── test-menu-handlers.js             # ★ NEW 2026-05-03: メニュー応答 単体テスト（18項目）
│   ├── create-consultation.js            # ★ NEW 2026-05-03: 事務局向け相談会CLI (Phase 3b-1)
│   ├── test-consultation-flow.js         # ★ NEW 2026-05-03: 相談会フロー結合テスト（24項目）
│   ├── push-consultation-invites.js      # ★ NEW 2026-05-03: 参加打診push バッチ (Phase 3b-2)
│   ├── test-consultation-invite.js       # ★ NEW 2026-05-03: 参加打診push + postback テスト（21項目）
│   ├── run-consultation-reminders.js     # ★ NEW 2026-05-03: リマインド+アーカイブ配信統合バッチ (Phase 3b-3)
│   ├── test-consultation-reminders.js    # ★ NEW 2026-05-03: リマインド+アーカイブ結合テスト（28項目）
│   ├── test-feedback-recommend.js        # ★ NEW 2026-05-03: フィードバック→レコメンド改善テスト（25項目, Phase 6）
│   ├── test-delivery-runner.js           # ★ NEW 2026-05-03: 配信ランナー結合テスト（14項目, A1）
│   ├── test-error-notifier.js            # ★ NEW 2026-05-03: エラー通知 単体テスト（27項目, A3）
│   ├── test-reason-ai.js                 # ★ NEW 2026-05-03: 動的推薦理由生成 単体テスト（12項目, D1）
│   ├── test-liff-history.js              # ★ NEW 2026-05-03: LIFF auth 単体テスト（19項目, B3）
│   └── test-collaborative-recommend.js   # ★ NEW 2026-05-03: 協調フィルタリング 結合テスト（19項目, D2）
├── db/
│   ├── schema.sql                        # MySQL DDL（3テーブル）
│   ├── schema_v2.sql                     # Initiatives / DeliveryLog / MatchingRequests 追加
│   ├── schema_v3.sql                     # Users.interests / disliked_categories / Initiatives.bullet_points
│   ├── schema_v4.sql                     # Users.pending_interest_picks
│   ├── schema_v5.sql                     # ★ NEW 2026-05-03: MatchingNotifications 追加（Phase 3a）
│   ├── schema_v6.sql                     # ★ NEW 2026-05-03: ConsultationEvents + ConsultationParticipants 追加（Phase 3b-1）
│   ├── schema_v7.sql                     # ★ NEW 2026-05-03: ConsultationParticipants.pushed_at 列追加（Phase 3b-2）
│   ├── schema_v8.sql                     # ★ NEW 2026-05-03: ConsultationParticipants.reminded_at + archive_pushed_at（Phase 3b-3）
│   ├── seed_initiatives.sql              # 配信ネタのダミー6件
│   ├── investigate_same_name.sql         # ★ NEW 2026-05-03: 同名ペア実態調査用SQL
│   ├── check_matching.sql / check_users.sql / reset_my_delivery.sql  # 確認用ユーティリティ
├── .env.example
├── .gitignore
├── package.json                          # ★ 2026-05-03: pdf-parse 追加 + import:initiatives script + check 拡張
├── package-lock.json
├── README.md
├── ROADMAP.md
├── DEPLOY.md
├── AZURE_SETUP.md
├── DESIGN_BRIEF_admin_console.md         # 事務局管理画面の RFP 兼ブリーフ
├── RFP_admin_console.md
├── assets/
│   └── rich-menu-template.svg            # ★ NEW 2026-05-03: リッチメニュー雛形SVG
├── docs/
│   ├── SCHEDULER_SETUP.md                # ★ NEW 2026-05-03: 週1配信スケジューラ運用手順 (A1)
│   ├── MONITORING_SETUP.md               # ★ NEW 2026-05-03: エラー監視運用手順 (A3, 3層構成)
│   └── LIFF_SETUP.md                     # ★ NEW 2026-05-03: LIFF Channel 発行〜運用手順 (B3)
├── public/liff/
│   └── history.html                      # ★ NEW 2026-05-03: LIFF配信履歴アプリ本体 (B3)
├── .github/workflows/
│   ├── main_tech0-gen-11-step4-node-3.yml  # 自動デプロイ（既存）
│   └── weekly-delivery.yml                 # ★ NEW 2026-05-03: 週1配信 cron (A1)
├── SESSION_NOTES_2026-05-03.md           # ★ NEW: 2026-05-03 セッションの作業ログ
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

## 5. これからやること（タスクリスト）— 2026-05-03 時点

優先度・依存関係順。✅ = 完了、🟡 = 部分着手、❌ = 未着手。

### スプリント1の残り（Phase 0 仕上げ）

| # | タスク | 概要 | 状態 | 担当候補 |
| --- | --- | --- | --- | --- |
| 21 | LINE Webhook URL を本番に切替 + Verify | App Service 立てた後、本番URLに差し替え | 🟡 App Service既デプロイ | 吉田 |
| 22 | 実機でフルオンボーディング動作確認 | スマホで一連のフロー確認、必要に応じて文言調整 | ❌ | 吉田 |
| **23** | 同名衝突 → 都道府県確認フロー実装 | `AWAITING_PREFECTURE` state 追加、Quick Reply で都道府県選択 | ✅ **2026-05-03 完了**（push 保留中、§9参照） | 永岡 |
| **24** | リッチメニュー設計と適用 | 「マイプロファイル / 配信履歴 / 話を聞きたい一覧 / 設定」の4ボタン | ✅ **2026-05-03 開発側完了**（画像PNG生成 + 本番投入のみ残） | 永岡（コード）＋ デザイナー（画像）＋ 吉田（適用） |

### スプリント2（Phase 1 + 2、〜3週間）

| 区分 | 内容 | 状態 |
| --- | --- | --- |
| Phase 1 | `Initiatives` テーブル設計と DDL 追加 | ✅ schema_v2 |
| **Phase 1** | 宣言PDFを取得 → Claude で構造化要約するバッチ作成 | ✅ **2026-05-03 完了** (`scripts/import-initiatives.js`) |
| Phase 1 | 抽出結果は `status='draft'` で保存、事務局レビュー後に `published` | ✅ 仕様どおり |
| Phase 1 | 本番投入: 数十社〜全件のバッチ実行 | ❌ コードはレディ、実行は吉田さんに |
| **Phase 2 / A1** | 週1配信スケジューラ（GitHub Actions cron + `/admin/run-delivery`） | ✅ **2026-05-03 完了**（`docs/SCHEDULER_SETUP.md`） |
| Phase 2 | レコメンド + Flex Carousel + DeliveryLog/Feedback | ✅ 既存 |
| Phase 2 | 配信フローのE2E動作確認 | ✅ **2026-05-03 結合テスト全パス** (`scripts/test-delivery-recommendation.js`) |

### スプリント3（Phase 3、〜4週間）

| 区分 | 内容 | 状態 |
| --- | --- | --- |
| Phase 3a | 配信カードに「話を聞きたい」 + `MatchingRequests` 記録 | ✅ 既存 |
| **Phase 3a** | しきい値検知（N件以上で発火）+ 事務局通知（メール/Slack） | ✅ **2026-05-03 完了** (`scripts/check-matching-threshold.js`) |
| **Phase 3b-1** | `ConsultationEvents` テーブル + 相談会作成フロー（事務局CLI） | ✅ **2026-05-03 完了** (`scripts/create-consultation.js`) |
| **Phase 3b-2** | 参加打診push + 参加表明/キャンセル postback | ✅ **2026-05-03 完了** (`scripts/push-consultation-invites.js` + `action=consult`) |
| **Phase 3b-3** | リマインド・アーカイブ配信 | ✅ **2026-05-03 完了** (`scripts/run-consultation-reminders.js`) |
| Phase 5 | 事務局向け簡易管理画面 | RFP発出中（外注） |

### スプリント4以降

- Phase 4: LIFF アプリ（マッチング体験の拡張）
- Phase 5: 事務局運用ツール（外注、`RFP_admin_console.md` 参照）
- **Phase 6: 配信フィードバックを使ったレコメンド改善** ✅ **2026-05-03 完了** (`recommend.js` のスコアに category別 helpful/not_helpful 累計を加味)
- **Phase 6 続き: プロファイル更新フロー** ❌ 未着手

詳しくは `ROADMAP.md` 参照。

### 推奨する次タスクの順序（2026-05-03 時点）

1. **全コミットの push 確定**（#23 + #24 + Phase 1 + Phase 3a + Phase 3b-1、コラボレーター追加 or fork、ブランチ分割推奨）
2. **#24 画像PNG作成 + 本番リッチメニュー適用**（吉田さん作業）
3. **Initiative AI バッチを 5〜10社で本番試走**（プロンプト品質の追加検証）
4. **Phase 2 配信スケジューラ実装**（Azure Functions Timer + run-delivery.js）
5. ~~#24 リッチメニュー設計~~ ✅ 2026-05-03 開発側完了
6. ~~Phase 3a しきい値検知 + 通知~~ ✅ 2026-05-03 完了
7. ~~Phase 3b-1 相談会の最小骨格~~ ✅ 2026-05-03 完了
8. ~~Phase 3b-2 参加打診push + 参加表明postback~~ ✅ 2026-05-03 完了
9. ~~Phase 3b-3 リマインド送信 + アーカイブ配信~~ ✅ 2026-05-03 完了
10. **Phase 3a/3b 本番運用：cron投入 + Slack Webhook 設定**（しきい値検知 / 招待 / リマインド / アーカイブ それぞれをスケジュール起動）
11. ~~Phase 2/A1 配信スケジューラ実装~~ ✅ 2026-05-03 完了（`/admin/run-delivery` + GitHub Actions cron、本番投入は `ADMIN_TOKEN` 設定のみ）
12. ~~Phase 6 配信フィードバック→レコメンド改善~~ ✅ 2026-05-03 完了
13. ~~A3 エラー監視~~ ✅ 2026-05-03 完了（`/admin/health` + Slack通知 + 重複抑制、本番投入は Azure Portal で Application Insights 1クリック + `SLACK_WEBHOOK_URL` 設定）
14. ~~D1 Claude動的推薦理由生成~~ ✅ 2026-05-03 完了
15. ~~B3 LIFF配信履歴アプリ~~ ✅ 2026-05-03 完了（LIFF Channel発行は本番投入時）
16. ~~D2 協調フィルタリング~~ ✅ 2026-05-03 完了
17. **Phase 4 LIFFアプリ**（マッチング体験の拡張、検索/フィルタ/申請履歴UI）
18. **プロファイル更新フロー**（既存ユーザーが事業内容変化を反映できるUI）

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

---

## 9. 保留中の commit と再開手順（2026-05-03 追記）

### 状況

ZIPダウンロードして解凍した作業フォルダに `git init` し、本家リポジトリ（`https://github.com/ysdthai0414/line-mvp-api`）を `origin` に設定して `feature/prefecture-collision` ブランチに以下のコミットがローカル保存されている：

```
83dbe7f feat: 同名衝突 → 都道府県QRで絞り込み (HANDOVER #23)
   7 files changed, 589 insertions(+), 11 deletions(-)
```

`git push -u origin feature/prefecture-collision` を試したが、永岡（GitHub username: `citymetal`）が ysdthai0414 のリポジトリにコラボレーター追加されていないため **403 Permission denied** で失敗。コミット自体はローカルに保持されている。

### 再開の選択肢

#### A. 吉田さんがコラボレーター追加してくれた場合

```powershell
cd D:\tech0\YNMO\line-mvp-api-main\line-mvp-api-main
git push -u origin feature/prefecture-collision
```
→ GitHub で PR 作成 → main へ merge → GitHub Actions が自動デプロイ。

#### B. fork して PR を送る場合

1. ブラウザで https://github.com/ysdthai0414/line-mvp-api を開き、`Fork` する
2. 自分のアカウント（citymetal）配下に `https://github.com/citymetal/line-mvp-api` ができる
3. PowerShell で:
   ```powershell
   git remote add fork https://github.com/citymetal/line-mvp-api.git
   git push -u fork feature/prefecture-collision
   ```
4. GitHub UI で `citymetal/line-mvp-api:feature/prefecture-collision` から `ysdthai0414/line-mvp-api:main` への PR を作る

### Initiative AI 関連の未コミット差分（同じく feature/prefecture-collision 上に積まれている可能性に注意）

2026-05-03 セッション後半で `src/pdf.js`, `src/initiative_ai.js`, `scripts/import-initiatives.js`, `scripts/test-delivery-recommendation.js`, および `package.json` / `scripts/run-sql.js` への修正、`db/investigate_same_name.sql` 追加 等が行われている。これらは **commit 83dbe7f には含まれていない**（commit 後に作成・編集されたため、作業ツリーに modified/untracked として残っているはず）。

push 再開時は：
- `git status` で modified/untracked を確認
- 別ブランチ `feature/initiative-ai` を切ってそちらに `git add` & `git commit` するのが筋（PRの粒度を分ける）
- `git checkout -b feature/initiative-ai` してから `git add -A && git commit -m "feat: ..."` と進める

### 万が一ローカル状態がよく分からなくなったら

```powershell
git status
git log --oneline -5
git branch
```
で現状を確認。最悪 `Remove-Item D:\tech0\YNMO\line-mvp-api-main\line-mvp-api-main\.git -Recurse -Force` で `.git` だけ消せば「ZIP解凍直後」状態に戻る（コードはそのまま残る）。

