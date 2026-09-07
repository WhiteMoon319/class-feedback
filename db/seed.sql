-- 本地开发种子数据：固定邀请码，便于手工验证注册流程。
-- 生产库不要执行本文件。
INSERT OR IGNORE INTO invites (code, type, duty, expires_at) VALUES
  ('DEV-STUDENT-0001',   'student',   NULL,   datetime('now', '+30 days')),
  ('DEV-STUDENT-0002',   'student',   NULL,   datetime('now', '+30 days')),
  ('DEV-COMMITTEE-0001', 'committee', '班长', datetime('now', '+30 days')),
  ('DEV-COMMITTEE-0002', 'committee', '生活委员', datetime('now', '+30 days')),
  ('DEV-OWNER-00000001', 'owner',     NULL,   datetime('now', '+30 days'));
