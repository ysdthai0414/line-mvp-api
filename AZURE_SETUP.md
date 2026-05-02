# Azure ポータル セットアップ手順 (MySQL版)

このプロジェクトは **Azure Database for MySQL Flexible Server** を使う前提。
SQL Server (Azure SQL Database) ではないので注意。

> **★ 控える値**
> - MySQL ホスト: `tech0-gen11-step4-class-4.mysql.database.azure.com`
> - MySQL ユーザー: `student`
> - MySQL パスワード（自分で設定したもの）
> - MySQL データベース名: `linemvp`
> - App Service の URL（後で確定）
> - LINE Channel Secret / Channel Access Token
> - Anthropic API Key

---

## ① MySQL のファイアウォール設定

すでにある `tech0-gen11-step4-class-4` を開いて:

1. 左メニュー **「設定」→「ネットワーク」**
2. **「+ 現在のクライアント IP アドレスを追加する」** をクリック → 自分の端末のIPがリストに追加される
3. **「Azure 内のすべてのリソースに対して、このサーバーへのパブリック アクセスを許可します」** にチェック ✓（App Service から接続するため必須）
4. **「保存」**

> 共有環境なので「すべてのIPを許可（0.0.0.0-255.255.255.255）」は **やらないこと**。

## ② linemvp データベース作成

1. 同サーバーの左メニュー **「設定」→「データベース」**
2. **「+ 追加」**
3. データベース名: **`linemvp`** / 文字セット: **`utf8mb4`** / 照合順序は既定でOK
4. **「保存」**

## ③ DDL を流す

Azure Database for MySQL Flexible Server には Azure SQL のような GUI クエリエディタが組み込まれていないので、いずれかの方法で。

### 方法A: Azure Cloud Shell（推奨・追加インストール不要）

1. ポータル右上の **Cloud Shell アイコン**（`>_` のマーク）をクリック → Bash を起動
2. 出てきたシェルで:
   ```bash
   # スキーマSQLをアップロードするには、Cloud Shell の「ファイルのアップロード」ボタンで
   # ローカルの db/schema.sql を選んでアップロード
   mysql \
     -h tech0-gen11-step4-class-4.mysql.database.azure.com \
     -u student -p \
     --ssl-mode=REQUIRED \
     linemvp < schema.sql
   ```
   パスワード入力でログイン。エラーが出なければ完了。

3. 確認:
   ```bash
   mysql -h tech0-gen11-step4-class-4.mysql.database.azure.com -u student -p \
     --ssl-mode=REQUIRED linemvp \
     -e "SHOW TABLES;"
   ```
   `ApprovedCompanies` `Profiles` `Users` の3つが見えればOK。

### 方法B: 手元の MySQL Workbench

1. 接続新規:
   - Hostname: `tech0-gen11-step4-class-4.mysql.database.azure.com`
   - Port: `3306`
   - Username: `student`
   - **SSL: Use SSL Required** ✓
2. ログイン後、`linemvp` を USE して `db/schema.sql` の内容を貼り付け実行

### 方法C: ローカルの mysql CLI

`mysql` クライアントが入っていれば:
```bash
mysql -h tech0-gen11-step4-class-4.mysql.database.azure.com -u student -p \
  --ssl-mode=REQUIRED linemvp < db/schema.sql
```

---

## ④ ローカルから認可リスト取り込み

ローカル端末で:

1. プロジェクトに `.env` を作成（`.env.example` を参考に値を埋める）:
   ```
   MYSQL_HOST=tech0-gen11-step4-class-4.mysql.database.azure.com
   MYSQL_PORT=3306
   MYSQL_USER=student
   MYSQL_PASSWORD=（自分で設定したもの）
   MYSQL_DATABASE=linemvp
   MYSQL_SSL=true
   ```
2. 依存をインストールして取り込み:
   ```bash
   npm install
   npm run import:approved -- C:\path\to\sengenkigyoichiran_20260420.xlsx
   ```
   3,135 件の MERGE ログが流れて完了。
3. 確認: Cloud Shell や Workbench で:
   ```sql
   SELECT COUNT(*) FROM ApprovedCompanies;
   -- 3135
   ```

---

## ⑤ App Service を作る

### 5-1. Web App 新規作成

1. ポータル上部検索 → **「App Service」** → **「+ 作成」→「Web アプリ」**
2. **基本** タブ:
   - リソース グループ: 既存の `rg-001-gen11`（同じグループに置くとSQL接続が速い）または新規 `line-mvp-rg`
   - **名前**: `linemvp-api-{自分の名前など}` ※全Azure内で一意 ★控える（URL は `https://<名前>.azurewebsites.net`）
   - 公開: **コード**
   - **ランタイム スタック: `Node 18 LTS`**
   - OS: **Linux**
   - 地域: **Southeast Asia**（MySQL と同じリージョンに合わせると速い）
   - **App Service プラン**: 価格プラン `B1 Basic` 以上
3. **「確認および作成」→「作成」**

### 5-2. 環境変数（App Settings）登録

1. App Service を開く → 左メニュー **「設定 → 構成」**
2. **「アプリケーション設定」** タブで以下を1つずつ追加:

| 名前 | 値 |
| --- | --- |
| `LINE_CHANNEL_SECRET` | LINE Developers Console |
| `LINE_CHANNEL_ACCESS_TOKEN` | 同上 |
| `ANTHROPIC_API_KEY` | console.anthropic.com で発行 |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` |
| `MYSQL_HOST` | `tech0-gen11-step4-class-4.mysql.database.azure.com` |
| `MYSQL_PORT` | `3306` |
| `MYSQL_USER` | `student` |
| `MYSQL_PASSWORD` | （MySQLパスワード） |
| `MYSQL_DATABASE` | `linemvp` |
| `MYSQL_SSL` | `true` |
| `WEBSITES_PORT` | `8080` |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` |

3. **「保存」** → **「続行」**（再起動）

### 5-3. 起動コマンド

1. 同「構成」画面の **「全般設定」** タブ
2. **スタートアップ コマンド: `node index.js`**
3. **「保存」**

---

## ⑥ アプリをデプロイ（ZIPデプロイ）

ローカルで `app.zip` を作る:

```powershell
# Windows PowerShell の場合
cd C:\Users\ysdys\OneDrive\デスクトップ\line-mvp-api
Compress-Archive -Path index.js,package.json,src,scripts,db,.env.example -DestinationPath app.zip -Force
```

Kudu の ZIP デプロイ画面にドラッグ&ドロップ:

1. ブラウザで `https://<App名>.scm.azurewebsites.net/ZipDeployUI` を開く
2. `app.zip` をドラッグ&ドロップ
3. ログがリアルタイム表示。`npm install` 完了 → Done

ヘルスチェック:
```
https://<App名>.azurewebsites.net/
→ "LINE MVP API is running!"
```

---

## ⑦ LINE Webhook URL 切替

LINE Developers Console:
- **Webhook URL**: `https://<App名>.azurewebsites.net/webhook`
- **「更新」** → **「検証」** → Success ✅
- **Webhookの利用: ON** / 応答メッセージ・あいさつメッセージ: 無効

---

## ⑧ 実機テスト

スマホで:
1. 友だち追加 → ようこそメッセージ
2. 認可済企業の名前+URL送信:
   ```
   コーリョー建販株式会社
   https://www.koryo-kenpan.co.jp
   ```
   → 数十秒後に Flex カード
3. 「これでOK」→ 確定 / 「やり直す」→ 再入力
4. 認可なし企業の名前 → お断り

ポータル側:
- App Service → **「ログ ストリーム」** で実行ログ
- MySQL: Cloud Shell で `SELECT * FROM Users; SELECT * FROM Profiles;`

