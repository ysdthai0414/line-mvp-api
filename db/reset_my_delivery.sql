-- 自分の配信履歴を消して、テストのために再配信できる状態に戻す
-- ※ MatchingRequests は残す（本物の申請を消さないため）
DELETE FROM DeliveryLog WHERE line_user_id = 'U3d806555cd04e986b94cfdcad87b98fb';
SELECT 'remaining DeliveryLog rows for me:' AS info, COUNT(*) AS cnt
FROM DeliveryLog WHERE line_user_id = 'U3d806555cd04e986b94cfdcad87b98fb';
