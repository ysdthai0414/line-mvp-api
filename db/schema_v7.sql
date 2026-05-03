-- =============================================================
-- 100億宣言支援AI - Phase 3b-2 (参加打診push) スキーマ追加
-- ConsultationParticipants に pushed_at 列を追加。
-- 既存 schema.sql 〜 schema_v6.sql の上に流す。
-- 何度実行してもOK（IF NOT EXISTS 互換は ALTER だと使えないので動的SQL）。
-- =============================================================

SET @add_pushed_at := IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'ConsultationParticipants'
      AND column_name = 'pushed_at'
  ),
  'SELECT 1',
  'ALTER TABLE ConsultationParticipants ADD COLUMN pushed_at DATETIME(3) NULL'
);
PREPARE stmt FROM @add_pushed_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 確認
SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS nullable
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name = 'ConsultationParticipants'
ORDER BY ordinal_position;
