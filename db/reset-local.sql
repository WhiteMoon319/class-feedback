-- 本地开发库重置：删表后由 migrations 重建。仅用于 --local。
-- d1_migrations 一并删除，否则 migrations apply 会误判「无迁移可应用」。
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS replies;
DROP TABLE IF EXISTS feedbacks;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS audit_head;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS d1_migrations;
