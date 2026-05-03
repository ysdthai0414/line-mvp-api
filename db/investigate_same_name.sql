-- =============================================================
-- 同名認可済企業の実態調査（同名衝突対応 #23 の準備）
-- 1) 同名（normalized）のペア・件数分布
-- 2) 同名かつ同都道府県の企業の有無
-- =============================================================

-- (1) 同名グループの数
SELECT 'same_name_groups' AS metric, COUNT(*) AS value
FROM (
  SELECT company_name_normalized
  FROM ApprovedCompanies
  GROUP BY company_name_normalized
  HAVING COUNT(*) > 1
) t;

-- (2) 同名グループの件数別分布（2社、3社、…の各カウント）
SELECT g.cnt AS companies_in_group, COUNT(*) AS group_count
FROM (
  SELECT company_name_normalized, COUNT(*) AS cnt
  FROM ApprovedCompanies
  GROUP BY company_name_normalized
  HAVING COUNT(*) > 1
) g
GROUP BY g.cnt
ORDER BY g.cnt;

-- (3) 同名ペアの実例（最大20件）：会社名 / 都道府県 / 業種大分類 / 売上
SELECT a.company_name_normalized,
       a.id AS id_a, a.company_name AS name_a, a.prefecture AS pref_a,
       a.industry_major AS ind_a, a.annual_sales AS sales_a,
       b.id AS id_b, b.company_name AS name_b, b.prefecture AS pref_b,
       b.industry_major AS ind_b, b.annual_sales AS sales_b
FROM ApprovedCompanies a
JOIN ApprovedCompanies b
  ON a.company_name_normalized = b.company_name_normalized
 AND a.id < b.id
ORDER BY a.company_name_normalized
LIMIT 20;

-- (4) 同名かつ同都道府県の企業（先頭採用フォールバック対象になる稀ケース）
SELECT a.company_name_normalized, a.prefecture, COUNT(*) AS dup_in_pref
FROM ApprovedCompanies a
GROUP BY a.company_name_normalized, a.prefecture
HAVING COUNT(*) > 1
ORDER BY dup_in_pref DESC, a.company_name_normalized;

-- (5) 同名グループのうち、都道府県が NULL なレコードがあるか（QR出せないケース）
SELECT a.company_name_normalized,
       SUM(a.prefecture IS NULL) AS null_pref_count,
       SUM(a.prefecture IS NOT NULL) AS non_null_pref_count
FROM ApprovedCompanies a
WHERE a.company_name_normalized IN (
  SELECT company_name_normalized
  FROM ApprovedCompanies
  GROUP BY company_name_normalized
  HAVING COUNT(*) > 1
)
GROUP BY a.company_name_normalized
HAVING SUM(a.prefecture IS NULL) > 0
ORDER BY a.company_name_normalized;
