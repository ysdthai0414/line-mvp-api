-- =============================================================
-- 100億宣言支援AI - Phase 4 (UI微調整) 用スキーマ追加
-- pending_interest_picks: 「マッチせず」フィードバック後に
--   関心テーマQuick Replyを再表示できる残り回数 (最大2回表示)
-- =============================================================

SET @add_picks := IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'Users'
      AND column_name = 'pending_interest_picks'
  ),
  'SELECT 1',
  'ALTER TABLE Users ADD COLUMN pending_interest_picks INT NOT NULL DEFAULT 0'
);
PREPARE stmt FROM @add_picks;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 確認
SELECT COLUMN_NAME AS column_name, COLUMN_DEFAULT AS default_value
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name = 'Users'
  AND column_name = 'pending_interest_picks';
