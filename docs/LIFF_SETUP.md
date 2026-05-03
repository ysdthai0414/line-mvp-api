# LIFF 配信履歴アプリ セットアップ手順 (B3)

ユーザーが LINE トーク内で「配信履歴」を見るための LIFF（LINE Front-end Framework）アプリ。

## アーキテクチャ

```
[ユーザー] LINE トーク内で「履歴」テキスト or リッチメニューから LIFF URL タップ
   ↓
[LINE アプリ内ブラウザ] /liff/history.html を開く
   ↓
[LIFF SDK] liff.init() → liff.getIDToken()
   ↓ Bearer <ID Token>
[App Service] GET /api/me/deliveries
   ↓ liff_auth.js が LINE verify API で検証 → line_user_id 取得
[backend] DB から直近30件取得 → JSON 返却
   ↓
[LIFF アプリ] HTML/CSS で一覧描画
```

## 1. LINE Login Channel を作成

1. [LINE Developers Console](https://developers.line.biz/console/) を開く
2. 既存の Provider 内で **「Channel を作成」→「LINE Login」**
3. Channel 名: `100億宣言支援AI - 履歴LIFF` 等
4. Channel Type: 「Web app」を選ぶ
5. 作成後、Basic settings から **Channel ID（数字）** を控える

## 2. LIFF アプリを登録

1. 上で作った LINE Login Channel の **「LIFF」タブ → 「Add」**
2. 設定値:

| 項目 | 値 |
| --- | --- |
| LIFF app name | `配信履歴` |
| Size | `Tall`（縦長、画面の8割使う） |
| Endpoint URL | `https://tech0-gen-11-step4-node-3.azurewebsites.net/liff/history.html?liffId=__SELF__` |
| Scope | `profile`, `openid` |
| Bot link feature | `On (Aggressive)` 推奨 |

> Endpoint URL の `?liffId=__SELF__` 部分はダミー。実際は LIFF SDK が自身の ID を知っているので、HTML から取り出す方法はいくつかある:
> - `<meta name="liff-id" content="2000xxxxxx-xxxxxxxx" />` を HTML に埋める（推奨）
> - URL クエリ `?liffId=2000xxxxxx-xxxxxxxx` で渡す（簡易）

3. 作成後、**LIFF ID**（例: `2000xxxxxx-xxxxxxxx`）と **LIFF URL**（`https://liff.line.me/2000xxxxxx-xxxxxxxx`）を控える

## 3. App Service の環境変数を設定

Azure Portal で App Service を開き、環境変数に以下を追加:

| 変数名 | 値 |
| --- | --- |
| `LIFF_CHANNEL_ID` | Step 1 で控えた **Channel ID（数字）** |

> `LIFF_DEV_MOCK_USER_ID` は本番では**設定しない**こと（設定すると認証バイパスされる）

保存後、サービスが自動再起動するまで待つ。

## 4. HTML に LIFF ID を埋める

`public/liff/history.html` の `<head>` 内に追加:

```html
<meta name="liff-id" content="2000xxxxxx-xxxxxxxx" />
```

または Endpoint URL に `?liffId=2000xxxxxx-xxxxxxxx` を付ける。

push して App Service にデプロイされれば、LIFF アプリから読み込まれるようになる。

## 5. 動作確認

### 5-1. LINE実機での確認

1. スマホの LINE で対象 Bot とのトーク画面を開く
2. テキストで `https://liff.line.me/2000xxxxxx-xxxxxxxx` を送る（or リッチメニューに登録）
3. リンクをタップすると、LINE 内ブラウザで `history.html` が開く
4. 初回はLINE Login 同意画面が出る → 同意
5. 配信履歴が一覧表示されれば成功

### 5-2. ローカル開発（LIFF 不要）

LIFF Channel を作る前にローカルで挙動を確認したい場合:

```powershell
# .env に開発モック設定
# LIFF_DEV_MOCK_USER_ID=U_DEV_TEST  （実在するCONFIRMEDユーザーIDが望ましい）
npm start

# ブラウザで開く
# http://localhost:8080/liff/history.html?_mockUserId=U_DEV_TEST
```

`?_mockUserId=...` クエリが付いていると、HTML 側が LIFF を初期化せず、`Bearer dev-mock` で API を叩く。サーバー側の `LIFF_DEV_MOCK_USER_ID` と一致しないと 503。

### 5-3. PowerShell から API を直接叩く

```powershell
# dev-mock 認証で
$url = "http://localhost:8080/api/me/deliveries?limit=10"
Invoke-WebRequest -Uri $url -Method GET `
  -Headers @{ "Authorization" = "Bearer dev-mock" } `
  | Select-Object -ExpandProperty Content
```

## 6. リッチメニューから LIFF を呼ぶ

すでに `setup-rich-menu.js` でリッチメニューを作っているので、「配信履歴」ボタンを LIFF URL に変えると LIFF アプリが開ける（postback の代わりに `type: "uri"` のアクションに）。

`scripts/setup-rich-menu.js` を改修して、`history` ボタンの action を以下に変更:

```js
{
  type: "uri",
  label: "配信履歴",
  uri: "https://liff.line.me/2000xxxxxx-xxxxxxxx"
}
```

> ただし、現状のテキスト返し版（直近5件をテキストで返す）も悪くないので、両方残すなら別ボタンにする等の検討余地あり。

## 7. トラブルシュート

| 症状 | 原因の見当 | 対処 |
| --- | --- | --- |
| LIFF アプリで「LIFF ID が設定されていません」 | `<meta name="liff-id">` 未設定 or `?liffId=...` 不在 | HTML を修正 or Endpoint URL を見直す |
| API が 401 で「ID token verification failed」 | LIFF Channel ID と App Service の `LIFF_CHANNEL_ID` 不一致 | 一致させる |
| API が 503 で「LIFF_CHANNEL_ID not configured」 | App Service 環境変数未設定 | Azure Portal で追加 |
| API が 503 で「dev-mock used but ... not set」 | `LIFF_DEV_MOCK_USER_ID` 未設定 | 開発時のみ `.env` に追加。本番では空 |
| 配信履歴が空 | DeliveryLog にこのユーザー宛の行が無い | 配信を一度実行する or 別 user で確認 |
