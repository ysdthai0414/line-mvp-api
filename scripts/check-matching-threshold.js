#!/usr/bin/env node
// =============================================================
// マッチングしきい値検知 + 事務局通知バッチ
//
// 使い方:
//   # 通常実行（しきい値=環境変数 MATCHING_THRESHOLD or 5）
//   node scripts/check-matching-threshold.js
//
//   # 通知を送らずに該当会社一覧だけ確認
//   node scripts/check-matching-threshold.js --dry-run
//
//   # しきい値を変える
//   node scripts/check-matching-threshold.js --threshold 3
//
//   # 直近通知済も無視して再送（重複抑制を解除）
//   node scripts/check-matching-threshold.js --force
//
// 動作:
//   1) MatchingRequests の status='pending' を approved_company ごとに集計
//   2) しきい値以上の会社を抽出
//   3) 直近 NOTIFY_REPEAT_DAYS (default 7) 日以内に通知済の会社はスキップ（--force で無効化）
//   4) Slack Webhook (SLACK_WEBHOOK_URL) に送信、未設定時はコンソール出力
//   5) 送信結果（sent/logged/failed）を MatchingNotifications に記録
//
// 環境変数:
//   MATCHING_THRESHOLD       しきい値のデフォルト（int、未指定なら 5）
//   NOTIFY_REPEAT_DAYS       同会社への再通知間隔の日数（int、未指定なら 7）
//   SLACK_WEBHOOK_URL        Slack incoming webhook URL（任意。未設定時はコンソール出力）
// =============================================================

try { require("dotenv").config(); } catch (_e) {}

const { getPool } = require("../src/db");
const {
  findCompaniesAboveThreshold,
  wasNotifiedRecently,
  recordNotification,
  DEFAULT_REPEAT_DAYS,
} = require("../src/matching");
const { sendNotification } = require("../src/notify");

function parseArgs(argv) {
  const args = {
    threshold: parseInt(process.env.MATCHING_THRESHOLD || "5", 10) || 5,
    repeatDays:
      parseInt(process.env.NOTIFY_REPEAT_DAYS || String(DEFAULT_REPEAT_DAYS), 10) ||
      DEFAULT_REPEAT_DAYS,
    dryRun: false,
    force: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--threshold" && next) {
      args.threshold = parseInt(next, 10) || args.threshold;
      i++;
    } else if (a.startsWith("--threshold=")) {
      args.threshold = parseInt(a.split("=")[1], 10) || args.threshold;
    } else if (a === "--repeat-days" && next) {
      args.repeatDays = parseInt(next, 10) || args.repeatDays;
      i++;
    } else if (a.startsWith("--repeat-days=")) {
      args.repeatDays = parseInt(a.split("=")[1], 10) || args.repeatDays;
    }
  }
  return args;
}

function buildNotificationArgs(company, threshold) {
  const title =
    "「" + company.company_name + "」へのマッチング申請が " +
    company.offer_count + " 件に到達しました";
  const summary =
    "認可企業「" + company.company_name + "」（" +
    (company.prefecture || "—") + "）への『話を聞きたい』申請が " +
    threshold + " 件以上集まりました。オンライン相談会の企画タイミングです。";
  const fields = {
    "申請件数": company.offer_count,
    "申請者数 (重複除外)": company.requester_count,
    "最古の申請日時": (company.oldest_at && new Date(company.oldest_at).toISOString()) || "—",
    "最新の申請日時": (company.latest_at && new Date(company.latest_at).toISOString()) || "—",
    "approved_company_id": company.company_id,
    "しきい値": threshold,
  };
  return { title, summary, fields };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(
    "[check-threshold] threshold=" + args.threshold +
    ", repeatDays=" + args.repeatDays +
    ", dryRun=" + args.dryRun +
    ", force=" + args.force
  );

  const companies = await findCompaniesAboveThreshold(args.threshold);
  console.log(
    "[check-threshold] " + companies.length +
      "社が しきい値 " + args.threshold + " 件以上の pending 申請あり"
  );
  if (companies.length === 0) {
    await getPool().end();
    process.exit(0);
  }

  let notified = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of companies) {
    console.log(
      "\n--- [" + c.company_id + "] " + c.company_name +
      " (" + (c.prefecture || "—") + ") : pending=" +
      c.offer_count + ", requesters=" + c.requester_count + " ---"
    );

    if (!args.force) {
      const recent = await wasNotifiedRecently(c.company_id, args.repeatDays);
      if (recent) {
        console.log("  → skip: 直近 " + args.repeatDays + " 日以内に通知済");
        skipped++;
        continue;
      }
    }

    const notifyArgs = buildNotificationArgs(c, args.threshold);
    let result;
    try {
      result = await sendNotification({ ...notifyArgs, dryRun: args.dryRun });
    } catch (err) {
      console.error("  ✗ send failed:", err.message);
      result = {
        ok: false,
        channel: "slack",
        status: "failed",
        payload: notifyArgs,
        error: err.message,
      };
    }

    console.log(
      "  channel=" + result.channel + " status=" + result.status +
      (result.dryRun ? " (dry-run)" : "")
    );

    // 履歴記録（dry-run でも履歴は残さない仕様にしておく）
    if (!args.dryRun) {
      try {
        await recordNotification({
          targetCompanyId: c.company_id,
          pendingCount: c.offer_count,
          threshold: args.threshold,
          channel: result.channel,
          status: result.status,
          payload: result.payload,
          errorMessage: result.error || null,
        });
      } catch (err) {
        console.error("  ✗ recordNotification failed:", err.message);
      }
    }

    if (result.ok) notified++;
    else failed++;
  }

  console.log("\n=== 集計 ===");
  console.log("  notified: " + notified);
  console.log("  skipped:  " + skipped);
  console.log("  failed:   " + failed);

  await getPool().end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[check-threshold] fatal:", err);
  process.exit(1);
});
