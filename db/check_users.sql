-- 現在のユーザー状態を一望する確認用SQL
SELECT line_user_id, state, sales_tier, approved_company_id,
       interests, disliked_categories,
       updated_at
FROM Users
ORDER BY updated_at DESC
LIMIT 20;

-- 確定済みプロファイル
SELECT p.id, p.line_user_id, ac.company_name, p.sales_tier, p.created_at
FROM Profiles p
LEFT JOIN ApprovedCompanies ac ON ac.id = p.approved_company_id
ORDER BY p.created_at DESC
LIMIT 20;

-- 配信履歴とフィードバック
SELECT dl.id, dl.line_user_id, i.title, i.category,
       dl.feedback, dl.delivered_at, dl.feedback_at
FROM DeliveryLog dl
JOIN Initiatives i ON i.id = dl.initiative_id
ORDER BY dl.delivered_at DESC
LIMIT 20;
