-- =============================================================
-- 100億宣言支援AI - Phase 3 (パーソナライズ + フィードバック) スキーマ追加
-- 既存 schema.sql / schema_v2.sql の上に流す。何度実行してもOK。
--
-- 注: ALTER TABLE ADD COLUMN IF NOT EXISTS は MySQL 8.0.29+ なので
-- 互換性のため information_schema 経由で動的SQLを組み立てる。
-- =============================================================

-- ---------- Users.interests ------------------------------------------
SET @add_interests := IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'Users'
      AND column_name = 'interests'
  ),
  'SELECT 1',
  'ALTER TABLE Users ADD COLUMN interests JSON NULL'
);
PREPARE stmt FROM @add_interests;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- Users.disliked_categories --------------------------------
SET @add_disliked := IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'Users'
      AND column_name = 'disliked_categories'
  ),
  'SELECT 1',
  'ALTER TABLE Users ADD COLUMN disliked_categories JSON NULL'
);
PREPARE stmt FROM @add_disliked;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- Initiatives.bullet_points --------------------------------
SET @add_bullets := IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'Initiatives'
      AND column_name = 'bullet_points'
  ),
  'SELECT 1',
  'ALTER TABLE Initiatives ADD COLUMN bullet_points JSON NULL'
);
PREPARE stmt FROM @add_bullets;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 確認 -----------------------------------------------------
SELECT 'Users columns' AS info;
SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'Users'
ORDER BY ordinal_position;

SELECT 'Initiatives columns' AS info;
SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'Initiatives'
ORDER BY ordinal_position;
