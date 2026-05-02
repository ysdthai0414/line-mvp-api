-- =============================================================
-- 100億宣言支援AI - MySQL 用スキーマ (Azure Database for MySQL Flexible Server)
-- 初回デプロイ時に linemvp データベースに対して一度だけ実行する
-- =============================================================

-- 既存テーブルがあっても安全に再実行できるように IF NOT EXISTS を使う

-- 認可済企業マスタ（中小企業庁公開「100億宣言企業一覧」から取り込む）
-- 売上高は億円単位ではなく「円」で保存する（取り込み時に変換）
CREATE TABLE IF NOT EXISTS ApprovedCompanies (
  id                       INT             AUTO_INCREMENT PRIMARY KEY,
  corporate_number         VARCHAR(13)     NOT NULL,                  -- 法人番号
  company_name             VARCHAR(256)    NOT NULL,                  -- 法人名（生データ）
  company_name_normalized  VARCHAR(256)    NOT NULL,                  -- 正規化名
  application_type         VARCHAR(64)     NULL,                      -- 単独申請 / 企業グループ
  prefecture               VARCHAR(32)     NULL,                      -- 本社所在地（都道府県）
  industry_major           VARCHAR(64)     NULL,                      -- 業種（大分類）
  industry_minor           VARCHAR(64)     NULL,                      -- 業種（中分類）
  employee_count           INT             NULL,                      -- 常時使用する従業員数
  annual_sales             BIGINT          NULL,                      -- 売上高（円）
  target_year              INT             NULL,                      -- 100億達成予定年
  declaration_pdf_url      VARCHAR(512)    NULL,                      -- 100億宣言PDFリンク
  source_row               JSON            NULL,                      -- 元データの行を JSON で保管
  created_at               DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY ux_corporate_number (corporate_number),
  KEY ix_normalized (company_name_normalized)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ユーザーごとのオンボーディング状態
-- state: 'NEW' | 'AWAITING_CONFIRM' | 'CONFIRMED' | 'NOT_APPROVED'
CREATE TABLE IF NOT EXISTS Users (
  line_user_id          VARCHAR(64)    NOT NULL PRIMARY KEY,
  state                 VARCHAR(32)    NOT NULL DEFAULT 'NEW',
  approved_company_id   INT            NULL,
  sales_tier            VARCHAR(32)    NULL,
  annual_sales          BIGINT         NULL,
  pending_company_name  VARCHAR(256)   NULL,
  pending_company_url   VARCHAR(512)   NULL,
  pending_profile_json  JSON           NULL,
  created_at            DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_users_approved
    FOREIGN KEY (approved_company_id) REFERENCES ApprovedCompanies(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 確定済みプロファイル（履歴も残す想定で複数行可）
CREATE TABLE IF NOT EXISTS Profiles (
  id                  INT            AUTO_INCREMENT PRIMARY KEY,
  line_user_id        VARCHAR(64)    NOT NULL,
  approved_company_id INT            NULL,
  company_name        VARCHAR(256)   NOT NULL,
  company_url         VARCHAR(512)   NOT NULL,
  sales_tier          VARCHAR(32)    NULL,
  annual_sales        BIGINT         NULL,
  profile_json        JSON           NOT NULL,
  created_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_profiles_line_user_id (line_user_id),
  CONSTRAINT fk_profiles_approved
    FOREIGN KEY (approved_company_id) REFERENCES ApprovedCompanies(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
