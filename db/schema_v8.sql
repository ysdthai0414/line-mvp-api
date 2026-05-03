-- =============================================================
-- 100億宣言支援AI - Phase 3b-3 (リマインド + アーカイブ配信) スキーマ追加
-- ConsultationParticipants に reminded_at / archive_pushed_at を追加。
-- 何度実行してもOK。
-- =============================================================

-- reminded_at: 開催前リマインド送信のタイミング
SET @add_reminded := IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'ConsultationParticipants'
      AND column_name = 'reminded_at'
  ),
  'SELECT 1',
  'ALTER TABLE ConsultationParticipants ADD COLUMN reminded_at DATETIME(3) NULL'
);
PREPARE stmt FROM @add_reminded;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- archive_pushed_at: 開催後アーカイブ配信のタイミング
SET @add_archive := IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'ConsultationParticipants'
      AND column_name = 'archive_pushed_at'
  ),
  'SELECT 1',
  'ALTER TABLE ConsultationParticipants ADD COLUMN archive_pushed_at DATETIME(3) NULL'
);
PREPARE stmt FROM @add_archive;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 確認
SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS nullable
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name = 'ConsultationParticipants'
ORDER BY ordinal_position;
