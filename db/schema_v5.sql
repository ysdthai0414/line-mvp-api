-- =============================================================
-- 100億宣言支援AI - Phase 3a (マッチングしきい値検知 + 通知) スキーマ追加
-- 既存 schema.sql / schema_v2.sql / schema_v3.sql / schema_v4.sql の上に流す。
-- 何度実行してもOK（IF NOT EXISTS）。
-- =============================================================

CREATE TABLE IF NOT EXISTS MatchingNotifications (
  id                          INT             AUTO_INCREMENT PRIMARY KEY,
  target_approved_company_id  INT             NOT NULL,
  pending_count_at_notify     INT             NOT NULL,    -- 通知時の pending 件数
  threshold_value             INT             NOT NULL,    -- 達成と判定したしきい値
  channel                     VARCHAR(32)     NOT NULL,    -- 'slack' | 'console' | 'log'
  status                      VARCHAR(32)     NOT NULL,    -- 'sent' | 'failed' | 'logged'
  payload                     JSON            NULL,        -- 通知メッセージや詳細
  error_message               VARCHAR(512)    NULL,        -- 失敗時のエラー文言
  notified_at                 DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_notif_target (target_approved_company_id, notified_at),
  KEY ix_notif_status (status, notified_at),
  CONSTRAINT fk_notif_target
    FOREIGN KEY (target_approved_company_id) REFERENCES ApprovedCompanies(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 確認
SELECT 'MatchingNotifications columns' AS info;
SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'MatchingNotifications'
ORDER BY ordinal_position;
