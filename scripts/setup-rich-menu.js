#!/usr/bin/env node
// =============================================================
// LINE リッチメニューを作成 + 画像アップロード + デフォルト設定
//
// 使い方:
//   # ペイロードだけ確認（API呼ばない）
//   node scripts/setup-rich-menu.js --dry-run --image-path ./assets/rich-menu.png
//
//   # 実際に LINE に登録（要 LINE_CHANNEL_ACCESS_TOKEN）
//   node scripts/setup-rich-menu.js --image-path ./assets/rich-menu.png
//
//   # 既存のリッチメニューを一覧表示
//   node scripts/setup-rich-menu.js --list
//
//   # 既存のリッチメニュー（ID指定）を削除
//   node scripts/setup-rich-menu.js --delete <richMenuId>
//
// オプション:
//   --image-path <path>     アップロードする画像ファイル (PNG / JPG, max 1MB, 推奨2500x1686)
//   --name <name>           リッチメニュー名（管理用、デフォルト "100億宣言支援AI Main Menu"）
//   --dry-run               ペイロード確認のみ、APIコールしない
//   --list                  既存のリッチメニュー一覧を出して終了
//   --delete <id>           指定IDのリッチメニューを削除して終了
//   --no-default            作成後にデフォルト設定しない
//
// 構成:
//   2500x1686 を 4分割 (左上/右上/左下/右下) → それぞれ postback
//     action=menu&item=profile  | history | offers | settings
//
// 注意:
//   画像アップロードは LINE の data API に POST します。 Content-Type は image/png か image/jpeg。
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const fs = require("fs");
const path = require("path");

const RICH_MENU_BASE = "https://api.line.me/v2/bot/richmenu";
const RICH_MENU_DATA = "https://api-data.line.me/v2/bot/richmenu";

const SIZE_LARGE = { width: 2500, height: 1686 }; // ボタン4個用

function parseArgs(argv) {
  const args = {
    imagePath: null,
    name: "100億宣言支援AI Main Menu",
    dryRun: false,
    list: false,
    deleteId: null,
    setDefault: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--list") args.list = true;
    else if (a === "--no-default") args.setDefault = false;
    else if (a === "--delete" && next) {
      args.deleteId = next;
      i++;
    } else if (a === "--image-path" && next) {
      args.imagePath = next;
      i++;
    } else if (a.startsWith("--image-path=")) {
      args.imagePath = a.split("=")[1];
    } else if (a === "--name" && next) {
      args.name = next;
      i++;
    } else if (a.startsWith("--name=")) {
      args.name = a.split("=")[1];
    }
  }
  return args;
}

function buildRichMenuPayload(name) {
  const halfW = Math.floor(SIZE_LARGE.width / 2);
  const halfH = Math.floor(SIZE_LARGE.height / 2);
  return {
    size: { width: SIZE_LARGE.width, height: SIZE_LARGE.height },
    selected: true,
    name,
    chatBarText: "メニュー",
    areas: [
      // 左上: マイプロファイル
      {
        bounds: { x: 0, y: 0, width: halfW, height: halfH },
        action: {
          type: "postback",
          data: "action=menu&item=profile",
          displayText: "マイプロファイル",
        },
      },
      // 右上: 配信履歴
      {
        bounds: { x: halfW, y: 0, width: halfW, height: halfH },
        action: {
          type: "postback",
          data: "action=menu&item=history",
          displayText: "配信履歴",
        },
      },
      // 左下: 話を聞きたい一覧
      {
        bounds: { x: 0, y: halfH, width: halfW, height: halfH },
        action: {
          type: "postback",
          data: "action=menu&item=offers",
          displayText: "話を聞きたい一覧",
        },
      },
      // 右下: 設定
      {
        bounds: { x: halfW, y: halfH, width: halfW, height: halfH },
        action: {
          type: "postback",
          data: "action=menu&item=settings",
          displayText: "設定",
        },
      },
    ],
  };
}

async function lineRequest(url, options = {}) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が未設定");
  const headers = {
    Authorization: "Bearer " + token,
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      "LINE API " + (options.method || "GET") + " " + url +
      " → " + res.status + " " + text.slice(0, 300)
    );
  }
  try { return text ? JSON.parse(text) : {}; }
  catch (_e) { return text; }
}

async function listRichMenus() {
  const data = await lineRequest(RICH_MENU_BASE + "/list");
  return data.richmenus || [];
}

async function deleteRichMenu(id) {
  await lineRequest(RICH_MENU_BASE + "/" + encodeURIComponent(id), {
    method: "DELETE",
  });
}

async function createRichMenu(payload) {
  const res = await lineRequest(RICH_MENU_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.richMenuId;
}

async function uploadRichMenuImage(richMenuId, imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  let contentType;
  if (ext === ".png") contentType = "image/png";
  else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
  else throw new Error("画像は .png または .jpg/.jpeg のみ対応: " + ext);
  const buf = fs.readFileSync(imagePath);
  if (buf.length > 1024 * 1024) {
    throw new Error("画像サイズが 1MB を超えています: " + buf.length + " bytes");
  }
  await lineRequest(RICH_MENU_DATA + "/" + encodeURIComponent(richMenuId) + "/content", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: buf,
  });
}

async function setDefaultRichMenu(richMenuId) {
  await lineRequest(
    "https://api.line.me/v2/bot/user/all/richmenu/" + encodeURIComponent(richMenuId),
    { method: "POST" }
  );
}

async function main() {
  const args = parseArgs(process.argv);

  // --list
  if (args.list) {
    const list = await listRichMenus();
    if (list.length === 0) {
      console.log("(リッチメニューは登録されていません)");
    } else {
      for (const r of list) {
        console.log("  - id=" + r.richMenuId + " name=「" + r.name + "」 size=" +
          r.size.width + "x" + r.size.height + " areas=" + (r.areas || []).length);
      }
    }
    return;
  }

  // --delete
  if (args.deleteId) {
    console.log("[setup-rich-menu] deleting richMenuId=" + args.deleteId);
    await deleteRichMenu(args.deleteId);
    console.log("  ✓ deleted");
    return;
  }

  // create
  if (!args.imagePath) {
    console.error("--image-path を指定してください（PNG/JPG、推奨 2500x1686、≤1MB）");
    process.exit(1);
  }

  const payload = buildRichMenuPayload(args.name);
  console.log("[setup-rich-menu] payload:");
  console.log(JSON.stringify(payload, null, 2));

  if (args.dryRun) {
    console.log("\n→ dry-run: API は呼びません。");
    console.log("画像パス: " + args.imagePath +
      (fs.existsSync(args.imagePath)
        ? " (存在、" + fs.statSync(args.imagePath).size + " bytes)"
        : " ⚠ ファイルが見つかりません"));
    return;
  }

  if (!fs.existsSync(args.imagePath)) {
    console.error("画像が見つかりません: " + args.imagePath);
    process.exit(1);
  }

  console.log("\n[1/3] リッチメニュー作成");
  const richMenuId = await createRichMenu(payload);
  console.log("  ✓ richMenuId = " + richMenuId);

  console.log("\n[2/3] 画像アップロード");
  await uploadRichMenuImage(richMenuId, args.imagePath);
  console.log("  ✓ uploaded: " + args.imagePath);

  if (args.setDefault) {
    console.log("\n[3/3] デフォルト設定");
    await setDefaultRichMenu(richMenuId);
    console.log("  ✓ set as default for all users");
  } else {
    console.log("\n[3/3] スキップ: --no-default 指定のためデフォルト未設定");
  }

  console.log("\n=== 完了 ===");
  console.log("richMenuId: " + richMenuId);
  console.log("既存メニューを置き換える場合は古い方を削除:");
  console.log("  node scripts/setup-rich-menu.js --delete <oldId>");
}

main().catch((err) => {
  console.error("[setup-rich-menu] fatal:", err.message || err);
  process.exit(1);
});
