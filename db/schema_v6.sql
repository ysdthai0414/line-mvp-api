-- =============================================================
-- 100億宣言支援AI - Phase 3b-1 (相談会の最小骨格) スキーマ追加
-- 既存 schema.sql 〜 schema_v5.sql の上に流す。
-- 何度実行してもOK（IF NOT EXISTS）。
-- =============================================================

-- ConsultationEvents: 1相談会につき1行
CREATE TABLE IF NOT EXISTS ConsultationEvents (
  id                          INT             AUTO_INCREMENT PRIMARY KEY,
  host_approved_company_id    INT             NOT NULL,
  title                       VARCHAR(256)    NOT NULL,
  description                 VARCHAR(2000)   NULL,
  scheduled_at                DATETIME(3)     NOT NULL,
  duration_minutes            INT             NOT NULL DEFAULT 60,
  zoom_url                    VARCHAR(512)    NULL,
  capacity                    INT             NOT NULL DEFAULT 0,        -- 0 = 無制限
  status                      VARCHAR(32)     NOT NULL DEFAULT 'planned',
  -- 'planned' (企画中、参加打診前)
  -- 'recruiting' (募集中、参加打診済み)
  -- 'confirmed' (開催確定、定員に達した or 締切後)
  -- 'held' (開催済)
  -- 'cancelled' (中止)
  archive_url                 VARCHAR(512)    NULL,
  notes                       JSON            NULL,
  created_at                  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_event_status (status, scheduled_at),
  KEY ix_event_host (host_approved_company_id, scheduled_at),
  CONSTRAINT fk_event_host
    FOREIGN KEY (host_approved_company_id) REFERENCES ApprovedCompanies(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ConsultationParticipants: 1相談会×1ユーザーで1行
CREATE TABLE IF NOT EXISTS ConsultationParticipants (
  id                          INT             AUTO_INCREMENT PRIMARY KEY,
  consultation_event_id       INT             NOT NULL,
  line_user_id                VARCHAR(64)     NOT NULL,
  status                      VARCHAR(32)     NOT NULL DEFAULT 'invited',
  -- 'invited' (打診済、ユーザー応答待ち)
  -- 'joined' (参加表明)
  -- 'declined' (辞退)
  -- 'attended' (実際に参加した)
  -- 'absent' (欠席)
  -- 'cancelled' (一度参加表明したがキャンセル)
  source_matching_request_id  INT             NULL,
  invited_at                  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  responded_at                DATETIME(3)     NULL,
  notes                       VARCHAR(500)    NULL,
  UNIQUE KEY ux_event_user (consultation_event_id, line_user_id),
  KEY ix_participant_user (line_user_id, status),
  KEY ix_participant_event (consultation_event_id, status),
  CONSTRAINT fk_participant_event
    FOREIGN KEY (consultation_event_id) REFERENCES ConsultationEvents(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_participant_user
    FOREIGN KEY (line_user_id) REFERENCES Users(line_user_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_participant_source_request
    FOREIGN KEY (source_matching_request_id) REFERENCES MatchingRequests(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 確認
SELECT 'ConsultationEvents columns' AS info;
SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'ConsultationEvents'
ORDER BY ordinal_position;

SELECT 'ConsultationParticipants columns' AS info;
SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'ConsultationParticipants'
ORDER BY ordinal_position;
