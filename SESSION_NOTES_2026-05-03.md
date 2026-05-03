# 作業ログ — 2026-05-03

担当: 永岡伸一（GitHub: citymetal / Email: citymetalgogo@gmail.com）
セッション目的: チームメンバー（吉田）が用意した LINE MVP プロジェクトをローカルに引き継ぎ、開発を続行できる状態にする

---

## 1. 何を進めたか（時系列）

### Phase A. ローカル環境セットアップ

1. ZIP解凍済みのソース（`D:\tech0\YNMO\line-mvp-api-main\line-mvp-api-main\`）を作業フォルダとして登録
2. `.env` を `.env.example` から作成し、必要な秘密値（LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / ANTHROPIC_API_KEY / MYSQL_PASSWORD）を埋めた
3. `npm install`（pdf-parse 追加前の状態で 142 packages）
4. `npm run check`（構文チェック）成功
5. Azure Database for MySQL のファイアウォールに自宅IP `27.143.57.13` を追加
6. DB接続テスト `SELECT COUNT(*) FROM ApprovedCompanies` → **3,135件** 取得確認
7. `npm start` でローカルサーバー起動 → http://localhost:8080/ で `LINE MVP API is running!` 確認

### Phase B. コードベース全体レビュー

`HANDOVER.md` / `README.md` / `ROADMAP.md` 読了し、`src/` 配下と `db/schema*.sql` の進化を確認。Phase 0-4 の実装状況を整理（詳細は HANDOVER.md §5 参照）。レビュー結果から「**Initiative の本物コンテンツが無い**」「**スケジューラが無い**」「**マッチングしきい値検知が無い**」が大きなギャップだと判明。

### Phase C. 同名衝突対応 (#23) 実装

HANDOVER記載の `AWAITING_PREFECTURE` フローを実装。

**変更したファイル**:
- `src/db.js` ＋3関数: `findApprovedCompaniesWithPrefecture`, `saveAwaitingPrefecture`, `getPendingCompanyInput`
- `src/onboarding.js` ＋2関数: `resolveByPrefecture`, `uniquePrefectures`
- `src/flex.js` ＋1関数: `buildPrefectureQuickReply`（末尾に「やり直す」を含む）
- `src/handlers.js` 改修: ambiguous時に `AWAITING_PREFECTURE` へ遷移、`action=prefecture` postback ハンドラ追加、`AWAITING_PREFECTURE` 状態でテキスト送信時のヒント、共通フローを `runProfileGeneration` に切り出し

**新規ファイル**:
- `scripts/test-prefecture-flow.js`（22項目の自動テスト）
- `db/investigate_same_name.sql`（同名ペア実態調査用）

**実データ調査の結果**:
- 同名グループ: 18 グループ（HANDOVER記載「15ペア」より多い）
- 17 グループが2社、1 グループが3社（シンコー：宮崎/長崎/富山）
- 同名×同都道府県の重複: **1件のみ**（ビーエムラボ大分県：株式会社 vs 有限会社）
- 都道府県NULLレコード: なし

**テスト結果**: `node scripts/test-prefecture-flow.js` → **22 passed, 0 failed**

**git 関連**:
- ZIP解凍だったため `.git` なし → `git init` + `git remote add origin https://github.com/ysdthai0414/line-mvp-api.git` + `git fetch origin main` + `git reset origin/main`
- `feature/prefecture-collision` ブランチ作成、`git commit -m "feat: 同名衝突 → 都道府県QRで絞り込み (HANDOVER #23)"` で commit `83dbe7f` 作成
- `git push -u origin feature/prefecture-collision` → **403 Permission denied to citymetal**（ysdthai0414 リポジトリへのコラボレーター権限なし）
- → push 保留中。`HANDOVER.md §9` に再開手順記載済み

### Phase D. Initiative AI 生成バッチ実装

HANDOVERのPhase 1課題「宣言PDFを取得 → Claudeで構造化要約バッチ」を実装。

**新規ファイル**:
- `src/pdf.js`: `pdf-parse` を使い、URLからPDFをfetchしてテキスト抽出。タイムアウト20s、サイズ上限8MB、テキスト上限12,000字、空テキスト検知
- `src/initiative_ai.js`: Claude APIで宣言PDFテキスト→構造化JSON。8カテゴリへの正規化付き、`mockAi=true` でAPIを呼ばずダミー返却
- `scripts/import-initiatives.js`: バッチ本体。`--company-id`, `--limit`, `--offset`, `--dry-run`, `--mock-ai`, `--force` オプション。冪等な UPSERT（`(approved_company_id, source='ai_generated')` 単位）

**修正ファイル**:
- `package.json`: `pdf-parse` 依存追加、`import:initiatives` script追加、`check` を新ファイル用に拡張
- `scripts/run-sql.js`: BOM対応 + 単文SELECT 結果が表示されるよう修正（既存バグ）

**段階的検証**:
- レベル1（dry-run、コスト 0）: id=154 株式会社大和の宣言PDFをfetch、793字のテキスト抽出 OK
- レベル2（mock-ai、コスト 0）: ダミーJSONで Initiatives id=19 への INSERT/UPDATE/skip 全動作OK
- レベル3（実Claude、コスト 約 $0.05）: 株式会社大和の宣言PDFから「住設・配管資材卸で『仕入先との共同ワーク』を成長手段に位置づけ」というタイトルで生成。bullet 5件、industry_tags 4件、target_themes 3件、category=「販路拡大」。**プロンプト調整不要レベルの品質**

### Phase E. 配信フロー結合テスト

**新規ファイル**:
- `scripts/test-delivery-recommendation.js`: テスト用 CONFIRMED ユーザーを作り、`recommendForUser()` の挙動を draft/published 両方で検証。`finally` 句で必ず元状態に戻す

**テスト結果**: **8 passed, 0 failed**

主要な確認:
- `status='draft'` の Initiative は推薦に出ない（事務局レビュー前ガード）
- `status='published'` に昇格すると id=19 が推薦リストに入り、score=**13** で最上位（industry 2×2 + theme 3×3 = 13）
- match reasons (`{industries, themes, interests, category}`) が正しく記録される
- テスト終了時に Initiative の status と Users/Profiles 等のテストレコードが完全に元通り

### Phase F. Phase 3a マッチングしきい値検知 + 事務局通知

HANDOVER 残タスク「Phase 3a しきい値検知 + 通知（メール/Slack）」を実装。

**新規ファイル**:
- `db/schema_v5.sql`: `MatchingNotifications` テーブル（通知履歴）
- `src/notify.js`: Slack Webhook送信 + コンソールfallback、`dryRun` 対応
- `scripts/check-matching-threshold.js`: バッチ本体。`--threshold` `--dry-run` `--force` `--repeat-days`
- `scripts/test-matching-threshold.js`: 結合テスト（pickテスト会社→ユーザー作成→申請→検知→通知ペイロード確認→履歴記録→重複抑制確認→クリーンアップ）

**修正ファイル**:
- `src/matching.js`: `findCompaniesAboveThreshold` / `wasNotifiedRecently` / `recordNotification` / `getRecentNotifications` 追加
- `.env.example`: `MATCHING_THRESHOLD` / `NOTIFY_REPEAT_DAYS` / `SLACK_WEBHOOK_URL` 追加
- `package.json`: `check`スクリプト拡張、`check:threshold` script 追加
- `scripts/import-initiatives.js`: 予防的バグ修正（mysql2の`LIMIT/OFFSET ?`バインド非対応に対応、整数化して文字列連結）

**設計判断**:
- DDL変更最小：1テーブル（`MatchingNotifications`）追加のみ
- しきい値とリピート間隔は環境変数 + CLIで上書き可能（`MATCHING_THRESHOLD=5`, `NOTIFY_REPEAT_DAYS=7` がデフォ）
- Slack Webhook 未設定時はコンソールに fallback、ステータスは `logged` で履歴記録（運用初期も Webhook 設定なしで本番動作可能）
- 直近 7 日以内に成功通知（sent/logged）があればスキップ。失敗（failed）は再試行対象として残る

**動作確認**:
- スキーマ反映: `node scripts/run-sql.js db/schema_v5.sql` → `MatchingNotifications` 7列が作成
- 結合テスト: `node scripts/test-matching-threshold.js` → **15 passed, 0 failed**
- 本番 dry-run: `node scripts/check-matching-threshold.js --dry-run` → デフォthreshold=5 では 0社（健全）
- threshold=1 dry-run: 株式会社森建設(鹿児島県)に 1件 pending あり（過去テストの残骸の可能性、本番5件には影響なし）

**遭遇した問題と対処**:
- `mysql2` の `execute()` は `LIMIT ?` のパラメータバインドを扱えない（`Error: Incorrect arguments to mysqld_stmt_execute`）→ `parseInt` で整数化して文字列連結に切替（SQLi 安全）
- 同じ問題が `import-initiatives.js` の `LIMIT ? OFFSET ?` にも潜在 → 予防的に修正

### Phase G. #24 リッチメニュー（4ボタン）開発側

HANDOVER 残タスク「#24 リッチメニュー設計と適用」のうち、開発側（コード）部分を実装。画像作成とLINE OAでの本番適用は分離。

**新規ファイル**:
- `assets/rich-menu-template.svg`: 4ボタンレイアウトのSVG雛形（2500x1686）。デザイナーへの渡し用
- `src/menu_handlers.js`: postback `action=menu&item=...` 5種（profile/history/offers/settings/settings_reset）の応答生成
- `scripts/setup-rich-menu.js`: LINE Messaging API の richmenu API でメニュー作成＋画像アップロード＋デフォルト設定。`--dry-run`/`--list`/`--delete`/`--no-default` 対応
- `scripts/test-menu-handlers.js`: 単体テスト（18項目）

**修正ファイル**:
- `src/db.js`: `getLatestProfile` / `getRecentDeliveries` / `getPendingMatchingForUser` / `clearUserInterests` 追加
- `src/flex.js`: `buildMyProfileFlex` 追加（マイプロファイル表示用）
- `src/handlers.js`: `action=menu` postback の `dispatchMenuPostback` ルーティング追加
- `package.json`: `check` を新ファイル用に拡張

**設計判断**:
- 4ボタン: マイプロファイル / 配信履歴 / 話を聞きたい一覧 / 設定（HANDOVER §3-1 準拠）
- マイプロファイル：完成（既存 `Profiles.profile_json` を Flex で表示）
- 設定：完成（現在の interests + 既存 categories.js Quick Reply で追加・変更）
- 配信履歴／話を聞きたい一覧：テキスト返答のスケルトン（Flex化は将来。MVP では情報伝達できれば十分）
- 画像生成は依存追加せず、デザイナー or 既製画像に依存（`--image-path` 引数）

**動作確認**:
- 構文チェック: `npm run check` → 全 26 ファイル OK
- 単体テスト: `node scripts/test-menu-handlers.js` → **18 passed, 0 failed**
- Setup script dry-run: `node scripts/setup-rich-menu.js --dry-run --image-path ./assets/dummy.png` → ペイロード正しく組み立て、4 areas が 1250x843 ずつ正しく配置、各 postback `data` が期待通り

**残作業（次セッション or 吉田さんタスク）**:
1. デザイナーに `assets/rich-menu-template.svg` を渡してPNG化（または既製画像を流用）
2. PNGを `assets/rich-menu.png` 等に配置
3. `node scripts/setup-rich-menu.js --image-path ./assets/rich-menu.png` でLINEに登録＋デフォルト適用
4. LINE実機でメニュー表示と各ボタンの応答を確認

### Phase H. Phase 3b-1 相談会の最小骨格

HANDOVER 残タスク「Phase 3b 事務局通知 + ConsultationEvents 作成フロー」のうち、**事務局CLI部分**を実装。ユーザー側の参加表明UIは後続（Phase 3b-2/3）として残す。

**新規ファイル**:
- `db/schema_v6.sql`: `ConsultationEvents` (12列) + `ConsultationParticipants` (9列) の2テーブル追加
- `src/consultation.js`: 11個の関数 — createEvent / getEvent / listEvents / updateEventStatus / updateEventFields / getParticipants / setParticipantStatus / inviteParticipantsFromMatchingRequests + 定数2つ
- `scripts/create-consultation.js`: 7サブコマンドCLI（list / show / create / invite / status / participants / set-participant）
- `scripts/test-consultation-flow.js`: 結合テスト（24項目）

**修正ファイル**:
- `package.json`: `check`スクリプト拡張、`npm run consult` script追加

**設計判断**:
- ステータスは VARCHAR(32) + コード側で whitelist 検証（DBレベルのenumは使わず、追加自由度を確保）
- イベントステータス: `planned` → `recruiting` → `confirmed` → `held` / `cancelled`
- 参加者ステータス: `invited` → `joined`/`declined` → `attended`/`absent` / `cancelled`
- `inviteParticipantsFromMatchingRequests` は同一トランザクションで:
  - pending な MatchingRequests を全件取得
  - INSERT IGNORE で ConsultationParticipants に 'invited' で入れる（既存スキップ）
  - MatchingRequests.status を 'queued_for_event' へ一括更新
- FK制約: ConsultationParticipants.source_matching_request_id は ON DELETE SET NULL（追跡用、絶対参照ではない）

**動作確認**:
- スキーマ反映: `node scripts/run-sql.js db/schema_v6.sql` → 2テーブル作成、12列+9列確認
- 結合テスト: `node scripts/test-consultation-flow.js` → **24 passed, 0 failed**
- CLI動作確認: `node scripts/create-consultation.js list` → "(該当する相談会はありません)" （クリーンな状態）

**残作業（後続タスク）**:
- Phase 3b-2: 「参加しますか？」push + postback で `joined`/`declined` を更新 → ✅ 同セッション内で完了（次の Phase I）
- Phase 3b-3: 開催前リマインド + 開催後アーカイブ配信
- Phase 5: 事務局向けGUI（外注 RFP発出中、その間は CLI で運用）

### Phase I. Phase 3b-2 参加打診push + 参加表明postback

HANDOVER 残タスク「Phase 3b 参加表明・キャンセル」を実装。事務局CLIで作った相談会の参加候補（invited な ConsultationParticipants）にLINEのFlex Messageでpushし、ユーザーが「参加する／キャンセル」をタップしたらDBに反映する。

**新規ファイル**:
- `db/schema_v7.sql`: `ConsultationParticipants.pushed_at` 列を追加（push送信タイミング記録、idempotent な再実行のため）
- `scripts/push-consultation-invites.js`: バッチ。`--event-id <id>`、`--dry-run`、`--force`（pushed_at全クリア） 対応、500ms間隔
- `scripts/test-consultation-invite.js`: 結合テスト（21項目）

**修正ファイル**:
- `src/consultation.js`: `getInvitedNotPushed` / `markPushed` / `clearPushedAt` を追加
- `src/flex.js`: `buildConsultationInviteFlex(event)` を追加。ヘッダー紺色、ボディに日時/所要時間/定員、フッターに「キャンセル」「参加する」ボタン2個。Zoom URLは「参加する」を押した後に提示する設計（事前提示でキャンセルを促さない）
- `src/handlers.js`: `action=consult&event_id=N&value=join|decline` postback を実装。`getEvent` で存在確認 → `setParticipantStatus` で 'joined'/'declined' に更新 → joinならZoom URL付きの謝意、declineなら見送りのお詫び
- `package.json`: `check`スクリプト拡張、`npm run consult:push` script追加

**設計判断**:
- 「参加打診」は `status='invited' AND pushed_at IS NULL` を対象（冪等）
- push 失敗時は `pushed_at` を更新しないので、再実行で再送可能
- `--force` は `pushed_at` を全クリアして再送可（運用時の救済策）
- Zoom URL は join回答後に提示（参加意向の確度を上げる）
- postback の `displayText` は LINE 上に「参加します」「今回は参加を見送ります」として残るので、トーク履歴がきれいに残る

**動作確認**:
- スキーマ反映: `node scripts/run-sql.js db/schema_v7.sql` → `pushed_at` 列追加確認
- 結合テスト: `node scripts/test-consultation-invite.js` → **21 passed, 0 failed**
- Push バッチ dry-run: `node scripts/push-consultation-invites.js --event-id 1 --dry-run` → "ConsultationEvent id=1 が見つかりません" を確認（テスト後の正しい状態）

**残作業（最後の Phase 3b-3）**:
- 開催前リマインド：scheduled_at の 24時間前に joined ユーザーへ push（cron想定）
- 開催後アーカイブ配信：archive_url を attended/joined ユーザーへ push
→ ✅ 同セッション内で完了（次の Phase J）

### Phase J. Phase 3b-3 リマインド送信 + アーカイブ配信

HANDOVER 残タスク「Phase 3b 参加表明・キャンセル・**リマインド・アーカイブ配信**」のうちラスト2つを実装。これでマッチングループのコード化が完成。

**新規ファイル**:
- `db/schema_v8.sql`: `ConsultationParticipants.reminded_at` / `archive_pushed_at` 2列を追加（送信タイミング記録、冪等性確保）
- `scripts/run-consultation-reminders.js`: 統合バッチ。`--mode reminder|archive|both`、`--event-id`、`--hours-ahead`、`--dry-run` 対応、500ms間隔
- `scripts/test-consultation-reminders.js`: 結合テスト（28項目）

**修正ファイル**:
- `src/consultation.js`: 7関数追加 — getJoinedNotReminded / markReminded / getJoinedNotArchivePushed / markArchivePushed / findUpcomingEventsNeedingReminder / findHeldEventsNeedingArchivePush / clearReminderArchiveTimestamps
- `src/flex.js`: buildConsultationReminderFlex（オレンジ系 #E89F2A ヘッダー、Zoom URI ボタン）/ buildConsultationArchiveFlex（紺ヘッダー、archive_url URI ボタン）
- `package.json`: check 拡張、`npm run consult:reminders` script 追加

**設計判断**:
- リマインド対象: scheduled_at が NOW〜+N時間以内 AND status IN ('confirmed','recruiting') AND status='joined' AND reminded_at IS NULL の participant がいる event
- アーカイブ対象: status='held' AND archive_url IS NOT NULL AND status IN ('joined','attended') AND archive_pushed_at IS NULL
- リマインドのヘッダー色を意図的に変える（紺→オレンジ）ことで、配信/招待カードと視覚的に区別
- Zoom URL は招待時に隠して、リマインドで初めて目立つ位置にURIボタンとして提示
- `--mode both` を既定にして、cron からは1コマンドで両方カバー
- 失敗時は reminded_at / archive_pushed_at を更新しないので、再実行で再送可能

**動作確認**:
- スキーマ反映: `node scripts/run-sql.js db/schema_v8.sql` → 2列追加確認
- 結合テスト: `node scripts/test-consultation-reminders.js` → **28 passed, 0 failed**
- バッチ dry-run: `node scripts/run-consultation-reminders.js --mode both --dry-run` → 対象0件で終了（テスト後の正しい状態）

**残作業（最終運用面）**:
- Phase 3a/3b の cron 設定: `check-matching-threshold.js`, `push-consultation-invites.js`, `run-consultation-reminders.js` をそれぞれ Azure Functions Timer 等で定期起動
- Phase 2 配信スケジューラ実装（既存の `run-delivery.js` を週月末 cron で）
- Phase 6 レコメンド改善
- Phase 4 LIFF

---

### Phase K. Phase 6 配信フィードバック→レコメンド改善

HANDOVER 残タスク「Phase 6 配信フィードバック→レコメンド改善」を実装。DDL変更なしで、既存の `DeliveryLog.feedback` の累計を `recommend.js` のスコアリングに反映。

**修正ファイル**:
- `src/db.js`: `getCategoryFeedbackBias(lineUserId)` を追加。DeliveryLog × Initiatives を category 単位で helpful/not_helpful 集計し `{ "DX": +N, "M&A": -M, ... }` を返す
- `src/recommend.js`:
  - `SCORE_WEIGHT.feedback_category = 1` を追加
  - `getUserContext` で `feedbackBias` を併せて取得
  - `scoreInitiative` で `feedbackBias[init.category] × SCORE_WEIGHT.feedback_category` を加算
  - `reasons.feedbackBias` を追加（透明性のため）
- `package.json`: check 拡張

**新規ファイル**:
- `scripts/test-feedback-recommend.js`: 結合テスト（25項目）

**設計判断**:
- 集計単位は `category` のみ（8カテゴリ固定で確実、industry/theme は自由記述で粒度がブレる）
- 重みは `interest(4)` より控えめの `1` に設定。明示の希望を優先しつつ、暗黙シグナルで補完
- `disliked_categories` とは独立加算（disliked + 過去 not_helpful 両方なら大きくマイナス）
- `recommendForUser` の起点で1回だけ集計（N+1回避）
- スコア反映の透明性のため `reasons.feedbackBias` を露出

**動作確認**:
- 構文チェック: 全 33 ファイル OK
- 結合テスト: `node scripts/test-feedback-recommend.js` → **25 passed, 0 failed**
- 主要検証:
  - `getCategoryFeedbackBias` が `{ DX: +3, "M&A": -2 }` を返す（DX×3 helpful, M&A×2 not_helpful の集計が正しい）
  - 過去配信は除外される（DeliveryLog.initiative_id NOT IN は recommend 側既存ロジック）
  - **テスト由来 + シード由来**の Initiative 両方に対して category 別 bias が正しくクロスカット適用される
  - `reasons.feedbackBias` の値が +3 / -2 / 0 と正しく入る
  - `scoreInitiative` 単体検証: bias +5/-3/0 でスコアが直接動く

**意義**:
ユーザーが「マッチせず」を押すたびに、そのカテゴリの **全 Initiative** に -1 ずつのペナルティが累積する。逆に「マッチ」を押すたびに +1 累積。明示の interests/disliked と独立に学習が進むので、ユーザーが何もしなくてもレコメンド精度が上がる。

### Phase L. A1 週1配信スケジューラ

優先度A1 残タスク「毎週決まった曜日・時刻に run-delivery.js が自動実行される」を実装。GitHub Actions cron + App Service エンドポイントのハイブリッド方式を採用（FW触らない、Azure Functions追加デプロイ不要）。

**新規ファイル**:
- `src/delivery_runner.js`: 配信コアロジックを関数化（HTTP/CLI 共通）。dryRun/モック注入対応
- `.github/workflows/weekly-delivery.yml`: 月曜09:00 JST cron + workflow_dispatch（dry_run 入力対応）
- `scripts/test-delivery-runner.js`: 結合テスト（14項目）
- `docs/SCHEDULER_SETUP.md`: 運用手順書（ADMIN_TOKEN 生成/設定/動作確認/トラブルシュート）

**修正ファイル**:
- `index.js`: `POST /admin/run-delivery` エンドポイント追加（X-Admin-Token 認証、`/admin/*` 配下に JSON パーサ）
- `scripts/run-delivery.js`: 既存CLI仕様維持しつつ delivery_runner を呼ぶ薄いラッパに再構成
- `.env.example`: `ADMIN_TOKEN` 追加
- `package.json`: check 拡張

**設計判断**:
- **GitHub Actions cron + App Service endpoint** を採用（Azure Functions は追加せず、FW も触らない）
- ADMIN_TOKEN 未設定時は **503 で安全側無効化**（誤って公開されない）
- delivery_runner は HTTP/CLI/テストすべてから呼べる関数として切り出し
- LINE クライアントは引数で注入可能（テストでモック化）
- スリープ間隔も引数化（テストで sleepMs=0 で速攻実行）

**動作確認**:
- 構文チェック: 全 35 ファイル OK
- 結合テスト: `node scripts/test-delivery-runner.js` → **14 passed, 0 failed**
- CLI 後方互換: `node scripts/run-delivery.js --dry-run` で実DBの CONFIRMED ユーザー1名・3件レコメンド確認

**本番投入残作業**:
- Azure Portal で App Service の環境変数に `ADMIN_TOKEN` 追加
- GitHub Secrets に `APP_SERVICE_URL` と `ADMIN_TOKEN` 登録
- ワークフロー手動実行で動作確認（dry_run=true）
- main マージで cron が自動有効化、翌週月曜から本番運用開始

### Phase M. A3 エラー監視

優先度A3 残タスク「本番でエラーが起きたら誰かが気づく」を3層構成で実装。

**新規ファイル**:
- `src/error_notifier.js`: notifyError + 重複抑制 + fail-safe
- `scripts/test-error-notifier.js`: 単体テスト（27項目）
- `docs/MONITORING_SETUP.md`: 3層運用ガイド（Application Insights / アプリ内通知 / ヘルスチェック）

**修正ファイル**:
- `index.js`:
  - webhook handler の catch → notifyError 呼び出し（context: source/eventType/lineUserId）
  - `/admin/run-delivery` の catch → notifyError
  - **Express error middleware** 追加（同期/promise 例外を集約）
  - **process.on('unhandledRejection')** / **process.on('uncaughtException')** で notifyError、致命的時は1秒後に process.exit(1)
  - **`GET /admin/health`** 追加: DB ping (`SELECT 1`) + 必須環境変数 missing リスト → 200/503
- `.env.example`: `ERROR_NOTIFY_WINDOW_SECONDS`（既定300）、`ERROR_NOTIFY_DISABLED` 追加
- `package.json`: check 拡張

**設計判断**:
- **destructuring import を避ける**: error_notifier は `notifyMod.sendNotification` をプロパティ経由で呼ぶ（テストでモック差替えが効くため）。本セッション中に一度ハマって修正した
- **重複抑制の指紋**: `name + message先頭120字 + stack先頭1行` でハッシュ生成
- **fail-safe**: sendNotification 自体が throw しても error_notifier は throw せず `{ ok: false, error }` を返す（呼び出し側のメインロジックを止めない）
- **致命的例外時の挙動**: 通知が届く時間を確保するため 1秒 setTimeout 後に exit(1)。App Service が自動再起動する前提
- **Application Insights は Azure Portal で1クリック**ON（コード変更不要）

**動作確認**:
- 構文チェック: 全 37 ファイル OK
- 単体テスト: `node scripts/test-error-notifier.js` → **27 passed, 0 failed**
- 主要検証: describe/fingerprint/window制御/dryRun/disabled/重複抑制（モック）/resetCache/payload構造/異fingerprint独立/sendNotification失敗時のfail-safe

**遭遇した問題と対処**:
- 初版で `const { sendNotification } = require("./notify")` と destructuring していたため、テストの `notifyMod.sendNotification = mockFunc` が効かず STEP 6/7/8 で失敗
- → `const notifyMod = require("./notify")` + `notifyMod.sendNotification(...)` のプロパティ参照に変更し全パス

**本番投入残作業**:
- Azure Portal で App Service → Application Insights を1クリック有効化
- App Service の環境変数 `SLACK_WEBHOOK_URL` を Slack Incoming Webhook で設定（任意）
- PowerShell から `GET /admin/health` を叩いて 200 を確認
- （任意）GitHub Actions に health-check.yml を作成して 15分おきに ping

### Phase N. D1 Claude動的推薦理由生成

優先度D-1「現状は静的テンプレ → user profile + interests + 過去 feedback を渡して Claude が動的に推薦理由文を生成」を実装。

**新規ファイル**:
- `src/reason_ai.js`: `generateReasonText({user, initiative, reasons, mockAi})` で1〜2文の推薦理由を Claude 生成。fail-safe（失敗時 null）、`REASON_AI_DISABLED` で緊急停止、`mockAi` モード対応
- `scripts/test-reason-ai.js`: 単体テスト（12項目）

**修正ファイル**:
- `src/delivery_runner.js`: `attachDynamicReasons` 関数追加。`runDelivery` が LIVE モード時に各 rec に `_reasons._dynamicReason` を注入。dryRun時は既定 false でAPIコスト0（既存テストへの影響なし）
- `src/flex.js`: `buildReasonText` で `_dynamicReason` を最優先表示、無ければ既存の静的テンプレにフォールバック
- `.env.example`: `REASON_AI_DISABLED` 追加
- `package.json`: check 拡張

**設計判断**:
- **コスト最小化**: 1呼び出し ~$0.001、月100ユーザー × 3件 = $0.30 程度に収まる
- **dryRun時はAI呼ばない**: useDynamicReason 既定値を `!dryRun` にして既存テストの挙動を変えない
- **失敗耐性**: Claude失敗時は `_dynamicReason` 未セット → buildReasonText が既存の静的テンプレに自動フォールバック
- **緊急停止**: `REASON_AI_DISABLED=true` で全停止
- **テスト容易性**: `mockAi` モードで Claude 呼ばずに固定文字列返却

**動作確認**:
- 構文チェック: 全 38 ファイル OK
- 単体テスト: `node scripts/test-reason-ai.js` → **12 passed, 0 failed**
- 既存テスト影響なし: `test-delivery-runner.js` 14 passed、`test-delivery-recommendation.js` 8 passed（動作不変）

**意義**:
- これまで配信時の「あなたへ」テキストは「『DX』に関心あり…」のような3パターン静的テンプレだったが、Claude がユーザー固有のプロファイル・興味・過去のフィードバック傾向を統合した文章を毎回生成するようになる
- 例: 「卸売業の御社で、過去『DX』系の事例にご好評いただいていたので、配送センター改革の事例をピックアップしました」のような具体的な理由文が出る
- 静的テンプレと比べて、配信開封率・「マッチ」フィードバック率の向上が見込める

### Phase O. B3 LIFF配信履歴アプリ

優先度B-3「ユーザーが『先週の記事もう一度見たい』と思ったときに見られる」のうち、LIFF版を実装。テキスト返し版（リッチメニュー「配信履歴」）は今日の前半で完了済み。

**新規ファイル**:
- `src/liff_auth.js`: `verifyIdToken` (LINE verify API) + Express ミドルウェア + dev-mock モード
- `public/liff/history.html`: LIFF アプリ本体。LIFF SDK 初期化 → ID Token 取得 → API 呼び出し → カード形式で30件まで表示
- `scripts/test-liff-history.js`: 単体テスト（19項目）
- `docs/LIFF_SETUP.md`: LIFF Channel 発行〜運用手順

**修正ファイル**:
- `index.js`: `/api/me/deliveries` エンドポイント追加（liffAuthMiddleware 経由）、`/liff/` 静的配信、`/api` JSONパーサ
- `.env.example`: `LIFF_CHANNEL_ID` / `LIFF_DEV_MOCK_USER_ID` 追加
- `package.json`: check 拡張

**設計判断**:
- **認証**: LIFF v2 の ID Token を Bearer で送信、サーバーが LINE verify API で検証 → クライアント側偽装不可
- **dev-mock モード**: `LIFF_DEV_MOCK_USER_ID` 設定時のみ `Bearer dev-mock` で検証スキップ → ローカル開発で LIFF Channel 不要
- **安全側無効化**: `LIFF_CHANNEL_ID` 未設定なら 503 で全拒否
- **静的配信**: `public/liff/` を Express の `express.static` で公開、App Service デプロイにそのまま含まれる
- **依存追加なし**: 既存 fetch / Express / @line/bot-sdk のみ。LIFF SDK は CDN から
- **case-insensitive header**: Authorization / authorization 両方対応

**動作確認**:
- 構文チェック: 全 40 ファイル OK
- 単体テスト: `node scripts/test-liff-history.js` → **19 passed, 0 failed**
- ローカル起動: `npm start` → `Server running on port 8080` ✓
- LIFF アプリ: `http://localhost:8080/liff/history.html?_mockUserId=Uxxx` で開けば dev-mock 経由で履歴取得

**遭遇した問題と対処**:
- なし。一発でテスト全パス。

**本番投入残作業**:
- LINE Developers Console で LINE Login Channel + LIFF アプリ発行（手順は `docs/LIFF_SETUP.md`）
- App Service の環境変数 `LIFF_CHANNEL_ID` 設定
- HTML に `<meta name="liff-id">` を埋める（or Endpoint URL に `?liffId=...`）
- リッチメニューの「配信履歴」ボタンを `type: "uri"` で LIFF URL に変更（任意。テキスト版残しても良い）

### Phase P. D2 協調フィルタリング

優先度D-2「『クリックされた事例の特徴量』を蓄積して協調フィルタリング的に推薦精度を上げる」を実装。Phase 6（単独学習）の自然な拡張。

**新規ファイル**:
- `scripts/test-collaborative-recommend.js`: 結合テスト（19項目）

**修正ファイル**:
- `src/db.js`: `getCollaborativeScores(lineUserId, opts)` 追加。Jaccard的に最低N件共通（既定1）の類似ユーザーを抽出 → その集団が helpful にした事例ごとの人数を返す
- `src/recommend.js`:
  - `SCORE_WEIGHT.collab = 1.5` 追加
  - `COLLAB_SCORE_CAP = 5` 追加（暴走防止）
  - `getUserContext` で `collabScores` 取得
  - `scoreInitiative` で `min(collab, 5) × 1.5` を加算
  - `reasons.collab` / `reasons.collabCapped` を露出（透明性）
- `package.json`: check 拡張

**設計判断**:
- **DDL変更なし**: 既存 DeliveryLog × Initiatives × Users の集計のみ
- **アイテムベース協調**: 「自分の helpful 集合」と「他ユーザーの helpful 集合」の重なりで類似性判定（Jaccard的）
- **重み 1.5**: 暗黙シグナルなので明示の interest(4)/theme(3) より弱め、feedback_category(1) より強め
- **CAP 5**: 1件の人気事例で過剰加点を防ぐ（バイラル耐性）
- **N+1 回避**: ユーザーコンテキスト構築時に1回だけ集計

**動作確認**:
- 構文チェック: 全 41 ファイル OK
- 結合テスト: `node scripts/test-collaborative-recommend.js` → **19 passed, 0 failed**
- 主要検証: 4ユーザー×5 Initiative の小規模ケースで類似ユーザー抽出 / 自分既 helpful の除外 / 非類似ユーザーの除外 / minOverlap=2 で類似消える / CAP上限 / スコア計算 / 履歴ゼロのユーザーで空オブジェクト

**意義**:
- Phase 6（自分の過去フィードバックの category 単位累計）と組み合わせると、配信履歴がまだ少ないユーザーでも「自分と似た嗜好の人が好む事例」をレコメンドできる
- 例: ユーザーAが「DXのコーリョー建販事例」を helpful → 似た事例を helpful した B, C を発見 → B, C が高評価した別の事例（ASEAN進出など）を A にもバイアスかけて推薦
- レコメンド精度の総合的な仕上げ

---

## 8. マッチングループ全体の完成度（2026-05-03 終了時）

```
✅ オンボーディング（既存）
✅ Initiative AI 生成（Phase 1）
✅ 配信＆フィードバック（Phase 2）
✅ 「話を聞きたい」記録（既存）
✅ しきい値検知 + 事務局通知（Phase 3a）
✅ ConsultationEvent 作成 + 招待（Phase 3b-1）
✅ 参加打診 push + postback（Phase 3b-2）
✅ 開催前リマインド + 開催後アーカイブ（Phase 3b-3）
✅ フィードバック→レコメンド改善（Phase 6）
✅ 週1配信の自動実行スケジューラ（A1）
✅ エラー監視 + ヘルスチェック（A3）
✅ Claude動的推薦理由生成（D1） ← 今日追加
```

**ユーザー側のすべての対話パス、フィードバック学習（単独 + 協調）、自動配信、運用監視、AI動的推薦理由、LIFF配信履歴までコード化された**。

**「これからやってほしいこと」優先度A〜Dすべて、永岡担当タスクが完了**:
- 🔴 優先度A：3/3 ✅✅✅
- 🟡 優先度B：3/3 ✅✅✅
- 🟢 優先度C：C1（外注RFP発出中、内製CLIで暫定代替）/ C2（DB移行待ち）→ コード作業はなし
- 🔵 優先度D：2/2 ✅✅

**残るは Phase 4 マッチング LIFF（大規模UI、別プロジェクト感）／プロファイル更新フロー（HANDOVER記載、中規模）のみ**。

## 2. 累計差分

| 区分 | ファイル数 | 概要 |
| --- | --- | --- |
| 新規 | 39 | `src/pdf.js`, `src/initiative_ai.js`, `src/notify.js`, `src/menu_handlers.js`, `src/consultation.js`, `src/delivery_runner.js`, `src/error_notifier.js`, `src/reason_ai.js`, `src/liff_auth.js`, `scripts/import-initiatives.js`, `scripts/test-prefecture-flow.js`, `scripts/test-delivery-recommendation.js`, `scripts/check-matching-threshold.js`, `scripts/test-matching-threshold.js`, `scripts/setup-rich-menu.js`, `scripts/test-menu-handlers.js`, `scripts/create-consultation.js`, `scripts/test-consultation-flow.js`, `scripts/push-consultation-invites.js`, `scripts/test-consultation-invite.js`, `scripts/run-consultation-reminders.js`, `scripts/test-consultation-reminders.js`, `scripts/test-feedback-recommend.js`, `scripts/test-delivery-runner.js`, `scripts/test-error-notifier.js`, `scripts/test-reason-ai.js`, `scripts/test-liff-history.js`, `db/investigate_same_name.sql`, `db/schema_v5.sql`, `db/schema_v6.sql`, `db/schema_v7.sql`, `db/schema_v8.sql`, `assets/rich-menu-template.svg`, `public/liff/history.html`, `docs/SCHEDULER_SETUP.md`, `docs/MONITORING_SETUP.md`, `docs/LIFF_SETUP.md`, `.github/workflows/weekly-delivery.yml`, `SESSION_NOTES_2026-05-03.md` |
| 修正 | 12 | `src/db.js`, `src/handlers.js`, `src/onboarding.js`, `src/flex.js`, `src/matching.js`, `src/consultation.js`, `src/recommend.js`, `src/delivery_runner.js`, `index.js`, `package.json`, `.env.example`, `scripts/run-sql.js`, `scripts/run-delivery.js`, `scripts/import-initiatives.js`, `HANDOVER.md` |
| commit済み（83dbe7f, feature/prefecture-collision） | 7ファイル | Phase 0 #23 関連だけ |
| 未commit（作業ツリーに残存） | 42+ | Phase 1 / Phase 3a / #24 / Phase 3b-1/2/3 / Phase 6 / A1 / A3 / D1 / B3 / バグ修正 / ドキュメント更新 |
| 累計 自動テスト項目 | **252項目** | 22 (#23) + 8 (Phase 2) + 15 (Phase 3a) + 18 (#24) + 24 (Phase 3b-1) + 21 (Phase 3b-2) + 28 (Phase 3b-3) + 25 (Phase 6) + 14 (A1) + 27 (A3) + 12 (D1) + 19 (B3) + 19 (D2) すべて pass |

---

## 3. 動作確認済みコマンド

```powershell
# ローカルサーバー
npm start
# 構文チェック
npm run check
# DB接続テスト（ワンライナー）
node -e "require('dotenv').config(); const m=require('mysql2/promise'); m.createPool({host:process.env.MYSQL_HOST,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE,ssl:{rejectUnauthorized:false}}).execute('SELECT COUNT(*) AS n FROM ApprovedCompanies').then(r=>{console.log(r[0]);process.exit(0)}).catch(e=>{console.error('ERROR:',e.code||e.message);process.exit(1)})"

# 同名衝突フロー結合テスト (22項目)
node scripts/test-prefecture-flow.js

# Initiative AI バッチ（コスト0）
node scripts/import-initiatives.js --company-id 154 --dry-run
node scripts/import-initiatives.js --company-id 154 --mock-ai

# Initiative AI バッチ（コストあり、1社 約$0.05）
node scripts/import-initiatives.js --company-id 154           # 既存スキップ
node scripts/import-initiatives.js --company-id 154 --force   # 上書き

# 配信フロー結合テスト (8項目)
node scripts/test-delivery-recommendation.js

# Phase 3a スキーマ反映
node scripts/run-sql.js db/schema_v5.sql

# Phase 3a しきい値検知 + 通知 結合テスト (15項目)
node scripts/test-matching-threshold.js

# Phase 3a 本番チェック（実データ）
node scripts/check-matching-threshold.js                      # default threshold=5
node scripts/check-matching-threshold.js --dry-run            # 通知送らず確認
node scripts/check-matching-threshold.js --threshold 3        # しきい値変更
node scripts/check-matching-threshold.js --force              # 重複抑制を解除

# #24 リッチメニュー単体テスト (18項目)
node scripts/test-menu-handlers.js

# #24 リッチメニュー setup (本番投入)
node scripts/setup-rich-menu.js --dry-run --image-path ./assets/rich-menu.png  # 確認
node scripts/setup-rich-menu.js --image-path ./assets/rich-menu.png            # 本番
node scripts/setup-rich-menu.js --list                                           # 既存リスト
node scripts/setup-rich-menu.js --delete <richMenuId>                            # 削除

# Phase 3b-1 スキーマ反映
node scripts/run-sql.js db/schema_v6.sql

# Phase 3b-1 結合テスト (24項目)
node scripts/test-consultation-flow.js

# Phase 3b-1 事務局CLI（吉田さん向け運用ツール）
node scripts/create-consultation.js list
node scripts/create-consultation.js show <eventId>
node scripts/create-consultation.js create --company-id 154 --title "..." --datetime "2026-06-15 19:00" --duration 60 --zoom-url "https://zoom.us/..." --capacity 10
node scripts/create-consultation.js invite <eventId> [--company-id N]
node scripts/create-consultation.js status <eventId> recruiting|confirmed|held|cancelled
node scripts/create-consultation.js participants <eventId>
node scripts/create-consultation.js set-participant <eventId> <lineUserId> joined|declined|attended|absent|cancelled

# Phase 3b-2 スキーマ反映
node scripts/run-sql.js db/schema_v7.sql

# Phase 3b-2 結合テスト (21項目)
node scripts/test-consultation-invite.js

# Phase 3b-2 参加打診 push バッチ
node scripts/push-consultation-invites.js --event-id <id>            # 本番
node scripts/push-consultation-invites.js --event-id <id> --dry-run  # 確認
node scripts/push-consultation-invites.js --event-id <id> --force    # pushed_at全クリアして再送

# Phase 3b-3 スキーマ反映
node scripts/run-sql.js db/schema_v8.sql

# Phase 3b-3 結合テスト (28項目)
node scripts/test-consultation-reminders.js

# Phase 3b-3 リマインド + アーカイブ統合バッチ
node scripts/run-consultation-reminders.js --mode both                          # 両方（cron想定）
node scripts/run-consultation-reminders.js --mode reminder --hours-ahead 24     # リマインドのみ
node scripts/run-consultation-reminders.js --mode archive                       # アーカイブのみ
node scripts/run-consultation-reminders.js --mode both --event-id <id>          # 特定イベント
node scripts/run-consultation-reminders.js --mode both --dry-run                # 試走

# Phase 6 フィードバック→レコメンド改善 結合テスト (25項目)
node scripts/test-feedback-recommend.js

# 任意 SQL 実行
node scripts/run-sql.js path/to/file.sql
```

---

## 4. 次セッションで進める候補（優先順）

| # | タスク | 規模 | 備考 |
| --- | --- | --- | --- |
| 1 | 全コミットの push 確定（#23 + Phase 1 + Phase 3a + #24 + Phase 3b-1） | 小 | 吉田さんにコラボレーター追加依頼 or fork。ブランチ分割推奨 |
| 2 | #24 画像PNG生成 + 本番リッチメニュー適用 | 小〜中 | デザイナーへSVG手渡し or Inkscape等で変換、`setup-rich-menu.js` で適用 |
| 3 | Initiative AI バッチを 5〜10社で本番試走 | 中 | 業界・規模違いで品質バラつきを確認、必要ならプロンプト調整 |
| 4 | Phase 2 配信スケジューラ（Azure Functions Timer） | 中〜大 | `run-delivery.js` を週月末cronで自動起動 |
| ~~5~~ | ~~#24 リッチメニュー設計と適用~~ | — | ✅ 2026-05-03 開発側完了 |
| ~~6~~ | ~~Phase 3a マッチングしきい値検知 + 事務局通知~~ | — | ✅ 2026-05-03 完了 |
| ~~7~~ | ~~Phase 3b-1 相談会の最小骨格~~ | — | ✅ 2026-05-03 完了（事務局CLI部分） |
| ~~8~~ | ~~Phase 3b-2 参加打診push + postback (joined/declined)~~ | — | ✅ 2026-05-03 完了 |
| ~~9~~ | ~~Phase 3b-3 リマインド送信 + アーカイブ配信~~ | — | ✅ 2026-05-03 完了 |
| ~~10~~ | ~~Phase 6 配信フィードバック→レコメンド改善~~ | — | ✅ 2026-05-03 完了 |
| 5 | Phase 3a/3b 本番運用：cron投入 + Slack Webhook 設定 | 小 | `check-matching-threshold.js` / `push-consultation-invites.js` / `run-consultation-reminders.js` を Azure Functions Timer で定期起動 |
| 6 | Phase 2 配信スケジューラ実装（Azure Functions Timer） | 中〜大 | `run-delivery.js` を週月末cronで自動起動 |
| 7 | Phase 4 LIFF アプリ（マッチング体験の拡張） | 大 | LINE Login + 検索/フィルタ + 申請履歴 |
| 8 | プロファイル更新フロー | 中 | 既存ユーザーが事業内容変化を反映できるUI（リッチメニュー設定経由） |

---

## 5. 副次成果（小さな改善）

- `scripts/run-sql.js` のBOM対応 → PowerShell の `Out-File -Encoding utf8` で書いた SQL ファイルが SyntaxError にならず動くように
- `scripts/run-sql.js` の単文SELECT表示対応 → 単一の SELECT 文だけのSQLでも結果が `console.table` で出るように
- HANDOVER.md の最新化 → 2026-05-03時点のステータスを正確に反映

---

## 6. 既知の懸念・注意点

- **CRLF/LF警告**: Windows での `git add` 時に `LF will be replaced by CRLF` の警告が大量に出るが、機能には影響しない。気になるなら `.gitattributes` で `* text=auto eol=lf` 等を設定検討
- **同都道府県重複1件（ビーエムラボ大分県）**: `株式会社` と `有限会社` の違いだが、現在の `normalizeCompanyName` はどちらも除去するため衝突する。現状は「先頭採用＋warn」のフォールバックでMVP許容。完全解決には法人形態の保持か法人番号での絞り込みが必要
- **Initiative の bullet/tag/theme の文言粒度**: AI出力は素直で良いが、配信時に Flex Message のサイズに収まるかは要実機確認（特に `target_themes` の長文）
- **node_modules を OneDrive に置かないこと**: HANDOVER記載の通り壊れる事例あり。現状の `D:\tech0\` は OneDrive 同期外なのでOK

---

最終更新: 2026-05-03 23:XX JST
