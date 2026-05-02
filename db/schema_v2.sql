-- =============================================================
-- 100億宣言支援AI - 配信機能 (Phase 2) 用スキーマ追加
-- 既存スキーマ (schema.sql) の上に流す。何度実行してもOK。
-- =============================================================

-- 取り組み事例（配信のネタ）
-- approved_company_id = 取り組みを行っている認可済企業
-- status = 'draft' | 'published'  (draftは事務局レビュー中)
-- source = 'ai_generated' | 'manual'
CREATE TABLE IF NOT EXISTS Initiatives (
  id                   INT             AUTO_INCREMENT PRIMARY KEY,
  approved_company_id  INT             NOT NULL,
  title                VARCHAR(256)    NOT NULL,
  summary              VARCHAR(500)    NULL,                 -- 配信時に表示する短文（120字程度想定）
  detail_url           VARCHAR(512)    NULL,                 -- 詳細ページ（宣言PDF or 自社サイト）
  category             VARCHAR(64)     NULL,                 -- 採用 / 海外 / DX / M&A / 事業承継 / 資金調達 / 組織 等
  industry_tags        JSON            NULL,                 -- 例: ["建設業", "卸売"]
  target_themes        JSON            NULL,                 -- 例: ["採用強化", "DX"] どんな経営テーマの企業向けか
  cover_image_url      VARCHAR(512)    NULL,                 -- カルーセルのアイキャッチ
  status               VARCHAR(32)     NOT NULL DEFAULT 'draft',
  source               VARCHAR(32)     NULL,
  source_row           JSON            NULL,                 -- AI生成時の元情報を保管
  created_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_initiatives_status (status),
  KEY ix_initiatives_company (approved_company_id),
  CONSTRAINT fk_initiatives_company
    FOREIGN KEY (approved_company_id) REFERENCES ApprovedCompanies(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 配信履歴：誰にいつ何を配信したか + 反応
-- (line_user_id, initiative_id) で重複配信を判定
CREATE TABLE IF NOT EXISTS DeliveryLog (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  line_user_id    VARCHAR(64)    NOT NULL,
  initiative_id   INT            NOT NULL,
  delivered_at    DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  feedback        VARCHAR(32)    NULL,                       -- 'helpful' | 'not_helpful' | null
  feedback_at     DATETIME(3)    NULL,
  UNIQUE KEY ux_delivery (line_user_id, initiative_id),
  KEY ix_delivery_user (line_user_id),
  CONSTRAINT fk_delivery_user
    FOREIGN KEY (line_user_id) REFERENCES Users(line_user_id) ON DELETE CASCADE,
  CONSTRAINT fk_delivery_initiative
    FOREIGN KEY (initiative_id) REFERENCES Initiatives(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 「この会社の話を聞きたい」申請
-- target_approved_company_id = 話を聞きたい相手企業
-- source_initiative_id = どの配信から発火したか（任意）
-- status = 'pending' | 'queued_for_event' | 'closed'
CREATE TABLE IF NOT EXISTS MatchingRequests (
  id                          INT            AUTO_INCREMENT PRIMARY KEY,
  line_user_id                VARCHAR(64)    NOT NULL,
  target_approved_company_id  INT            NOT NULL,
  source_initiative_id        INT            NULL,
  status                      VARCHAR(32)    NOT NULL DEFAULT 'pending',
  requested_at                DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at                   DATETIME(3)    NULL,
  KEY ix_matching_user (line_user_id),
  KEY ix_matching_target (target_approved_company_id, status),
  CONSTRAINT fk_matching_user
    FOREIGN KEY (line_user_id) REFERENCES Users(line_user_id) ON DELETE CASCADE,
  CONSTRAINT fk_matching_target
    FOREIGN KEY (target_approved_company_id) REFERENCES ApprovedCompanies(id) ON DELETE CASCADE,
  CONSTRAINT fk_matching_initiative
    FOREIGN KEY (source_initiative_id) REFERENCES Initiatives(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
