-- 配信履歴
SELECT dl.id, dl.line_user_id, i.title, dl.delivered_at, dl.feedback
FROM DeliveryLog dl
JOIN Initiatives i ON i.id = dl.initiative_id
ORDER BY dl.delivered_at DESC
LIMIT 20;

-- 「話を聞きたい」申請
SELECT mr.id, mr.line_user_id, ac.company_name AS target_company,
       i.title AS source_initiative, mr.status, mr.requested_at
FROM MatchingRequests mr
LEFT JOIN ApprovedCompanies ac ON ac.id = mr.target_approved_company_id
LEFT JOIN Initiatives i ON i.id = mr.source_initiative_id
ORDER BY mr.requested_at DESC
LIMIT 20;
