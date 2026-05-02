-- =============================================================
-- Initiatives ダミーデータ（配信機能の動作確認用）
--
-- 使い方:
--   node scripts/run-sql.js db/seed_initiatives.sql
--
-- 仕様:
--  - source='seed' のレコードをいったん全削除してから再投入する（冪等）
--  - approved_company_id は ApprovedCompanies.company_name_normalized でルックアップ
--  - 各 tier (10_30 / 30_50 / 50_100 / OVER_100) を1件以上カバー
--  - status='published' で配信対象に乗せる
--  - bullet_points: 配信時に「要点」として2〜3点を表示
-- =============================================================

START TRANSACTION;

-- 既存の seed を一掃（手動で追加した本番データには触らない）
DELETE FROM Initiatives WHERE source = 'seed';

-- ---------------------------------------------------------------
-- (1) コーリョー建販株式会社  / 建設・卸売 / DX
-- ---------------------------------------------------------------
INSERT INTO Initiatives
  (approved_company_id, title, summary, detail_url, category,
   industry_tags, target_themes, bullet_points, cover_image_url, status, source)
SELECT
  ac.id,
  '建材商社の現場DX：見積もり工数を半減',
  '紙とFAX中心だった見積もり業務をクラウド化。営業1人あたりの処理件数が約2倍に。地方卸売業のDXモデルケース。',
  'https://example.com/cases/koryo-kenpan-dx',
  'DX',
  CAST('["建設業","卸売業"]' AS JSON),
  CAST('["DX","販路拡大"]' AS JSON),
  CAST('["紙とFAX中心の見積もり業務をクラウド化","営業1人あたりの処理件数が約2倍に","地方卸売業のDXモデルケース"]' AS JSON),
  NULL,
  'published',
  'seed'
FROM ApprovedCompanies ac
WHERE ac.company_name_normalized = 'コーリョー建販'
LIMIT 1;

-- ---------------------------------------------------------------
-- (2) 採用テーマ（30〜50億帯）
-- ---------------------------------------------------------------
INSERT INTO Initiatives
  (approved_company_id, title, summary, detail_url, category,
   industry_tags, target_themes, bullet_points, cover_image_url, status, source)
SELECT
  ac.id,
  '中堅製造業の新卒採用：応募数3倍を実現した採用広報',
  '社員インタビュー動画と定例オープン社内見学を軸にした採用広報を1年で構築。母集団を質と量の両面で改善。',
  'https://example.com/cases/manufacturing-recruit',
  '人材確保・育成',
  CAST('["製造業"]' AS JSON),
  CAST('["人材確保・育成"]' AS JSON),
  CAST('["社員インタビュー動画で職場の解像度を上げる","定例オープン社内見学を月1で開催","応募数3倍・内定承諾率も改善"]' AS JSON),
  NULL,
  'published',
  'seed'
FROM ApprovedCompanies ac
WHERE ac.annual_sales IS NOT NULL
  AND ac.annual_sales >= 3000000000
  AND ac.annual_sales <  5000000000
ORDER BY ac.id
LIMIT 1;

-- ---------------------------------------------------------------
-- (3) 海外展開テーマ（50〜100億帯）
-- ---------------------------------------------------------------
INSERT INTO Initiatives
  (approved_company_id, title, summary, detail_url, category,
   industry_tags, target_themes, bullet_points, cover_image_url, status, source)
SELECT
  ac.id,
  'ASEAN進出1年目：商社を介さない直販モデル',
  'ベトナム・タイで現地法人を立ち上げ、商社を介さない直販に切り替え。為替リスクと与信管理の運用体制を解説。',
  'https://example.com/cases/asean-direct',
  '海外展開',
  CAST('["製造業","卸売業"]' AS JSON),
  CAST('["海外展開","新事業・多角化"]' AS JSON),
  CAST('["ベトナム・タイで現地法人を立ち上げ","商社を介さない直販モデルに切り替え","為替・与信管理の運用体制を整備"]' AS JSON),
  NULL,
  'published',
  'seed'
FROM ApprovedCompanies ac
WHERE ac.annual_sales IS NOT NULL
  AND ac.annual_sales >= 5000000000
  AND ac.annual_sales <  10000000000
ORDER BY ac.id
LIMIT 1;

-- ---------------------------------------------------------------
-- (4) M&A・事業承継（OVER_100）
-- ---------------------------------------------------------------
INSERT INTO Initiatives
  (approved_company_id, title, summary, detail_url, category,
   industry_tags, target_themes, bullet_points, cover_image_url, status, source)
SELECT
  ac.id,
  '同業3社をロールアップ：100億超え経営者が語る統合PMI',
  '同業のオーナー社長3人を巻き込んだロールアップ型M&A。買収後100日のPMI体制と、人事制度の統一プロセスを公開。',
  'https://example.com/cases/rollup-pmi',
  'M&A',
  CAST('["製造業","建設業","卸売業"]' AS JSON),
  CAST('["M&A","事業承継"]' AS JSON),
  CAST('["同業3社のオーナー社長を巻き込むロールアップ","買収後100日のPMI体制を先に決め切る","人事制度を半年で統一するプロセス"]' AS JSON),
  NULL,
  'published',
  'seed'
FROM ApprovedCompanies ac
WHERE ac.annual_sales IS NOT NULL
  AND ac.annual_sales >= 10000000000
ORDER BY ac.id
LIMIT 1;

-- ---------------------------------------------------------------
-- (5) 資金調達（10〜30億帯）
-- ---------------------------------------------------------------
INSERT INTO Initiatives
  (approved_company_id, title, summary, detail_url, category,
   industry_tags, target_themes, bullet_points, cover_image_url, status, source)
SELECT
  ac.id,
  '銀行3行リレーションで実現した5億円のシ・ローン',
  'メインバンク偏重だった資金繰りを、サブメイン2行とのリレーション構築でシンジケートローンに発展。設備投資の打ち手が広がった事例。',
  'https://example.com/cases/syn-loan',
  '設備投資・生産体制',
  CAST('["製造業","建設業"]' AS JSON),
  CAST('["設備投資・生産体制"]' AS JSON),
  CAST('["メインバンク偏重を解消しサブメイン2行と関係構築","シンジケートローンで5億円を調達","設備投資の打ち手が広がる"]' AS JSON),
  NULL,
  'published',
  'seed'
FROM ApprovedCompanies ac
WHERE ac.annual_sales IS NOT NULL
  AND ac.annual_sales >= 1000000000
  AND ac.annual_sales <  3000000000
ORDER BY ac.id
LIMIT 1;

-- ---------------------------------------------------------------
-- (6) 組織開発（30〜50億帯・第二弾）
-- ---------------------------------------------------------------
INSERT INTO Initiatives
  (approved_company_id, title, summary, detail_url, category,
   industry_tags, target_themes, bullet_points, cover_image_url, status, source)
SELECT
  ac.id,
  '評価制度を半年でゼロから刷新：離職率を半減',
  '年功色が強かった旧制度をMBO型に切替。役割等級と報酬テーブルの設計、現場マネジャーへの落とし込みまでを開示。',
  'https://example.com/cases/hr-eval',
  '人材確保・育成',
  CAST('["卸売業","サービス業"]' AS JSON),
  CAST('["人材確保・育成"]' AS JSON),
  CAST('["年功色を排しMBO型に切替","役割等級と報酬テーブルをセットで設計","離職率を半減・採用にも好影響"]' AS JSON),
  NULL,
  'published',
  'seed'
FROM ApprovedCompanies ac
WHERE ac.annual_sales IS NOT NULL
  AND ac.annual_sales >= 3000000000
  AND ac.annual_sales <  5000000000
ORDER BY ac.id DESC
LIMIT 1;

COMMIT;

-- 確認
SELECT i.id, ac.company_name, i.category, i.title, i.status,
       JSON_LENGTH(i.bullet_points) AS bullets
FROM Initiatives i
JOIN ApprovedCompanies ac ON ac.id = i.approved_company_id
WHERE i.source = 'seed'
ORDER BY i.id;
