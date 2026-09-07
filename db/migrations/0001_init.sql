-- 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- 初始 schema。设计要点：
--   1. 全库不存在任何真实身份字段（无学号、姓名、邮箱、手机号）——架构性匿名
--   2. members.display_name 为「根假名」，仅后端与本人可见，是封禁依据
--   3. feedbacks.alias 为「笔名」，每条反馈独立随机，是对外唯一可见的名字
--   4. 时间戳统一用 UTC（datetime('now')），展示层再按 +08:00 渲染

-- ========== 成员 ==========
CREATE TABLE IF NOT EXISTS members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name    TEXT    NOT NULL UNIQUE,               -- 根假名
  password_hash   TEXT    NOT NULL,                      -- PBKDF2-SHA512
  recovery_hash   TEXT    NOT NULL,                      -- 恢复码哈希（一次性展示，不留副本）
  role            TEXT    NOT NULL DEFAULT 'student' CHECK (role IN ('student','committee','owner')),
  duty            TEXT,                                  -- 职务，班委专用（如「生活委员」）
  session_version INTEGER NOT NULL DEFAULT 1,            -- 递增即全端登出（改密/重置时 +1）
  banned          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ========== 邀请码 ==========
-- used：0 未使用 / 1 已核销 / -1 已作废（过期或手动）
CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('student','committee','owner')),
  duty        TEXT,                                      -- 班委码携带的职务
  used        INTEGER NOT NULL DEFAULT 0,
  used_by     INTEGER REFERENCES members(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL                              -- 过期由 cron 标记作废
);
CREATE INDEX IF NOT EXISTS idx_invites_used ON invites(used, expires_at);

-- ========== 反馈工单 ==========
CREATE TABLE IF NOT EXISTS feedbacks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL REFERENCES members(id),    -- 根假名关联，仅后端
  alias      TEXT    NOT NULL,                           -- 本次随机笔名，对外展示
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_review','resolved')),
  hidden     INTEGER NOT NULL DEFAULT 0,                 -- 管理端隐藏（违规内容）
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_member ON feedbacks(member_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_list   ON feedbacks(hidden, created_at);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status, hidden);

-- ========== 回复 ==========
-- display_name 的取值口径：学生=所属反馈的笔名；班委实名=职务；班委匿名=「班委」。
-- member_id 始终保留以备追责，但任何接口都不返回它。
CREATE TABLE IF NOT EXISTS replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id  INTEGER NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
  member_id    INTEGER NOT NULL REFERENCES members(id),
  is_committee INTEGER NOT NULL DEFAULT 0,
  anonymous    INTEGER NOT NULL DEFAULT 0,               -- 班委按条自选匿名
  display_name TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  hidden       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_replies_feedback ON replies(feedback_id, hidden);

-- ========== 举报 ==========
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES members(id),
  target_type TEXT    NOT NULL CHECK (target_type IN ('feedback','reply')),
  target_id   INTEGER NOT NULL,
  reason      TEXT    NOT NULL,
  handled     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_open ON reports(handled, created_at);

-- ========== 班务公开 ==========
-- category=finance 时使用 amount/direction 记录收支；其余类别留空。
-- created_duty 存发布时的职务快照，事后改职务不影响历史公告署名。
CREATE TABLE IF NOT EXISTS announcements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT NOT NULL CHECK (category IN ('announcement','finance','minutes')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  amount       TEXT,                                     -- 金额，如「-128.00」
  direction    TEXT CHECK (direction IN ('income','expense') OR direction IS NULL),
  created_by   INTEGER NOT NULL REFERENCES members(id),
  created_duty TEXT NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ann_list ON announcements(category, pinned, created_at);

-- ========== 附件（仅班务公开侧，图片存 R2） ==========
CREATE TABLE IF NOT EXISTS attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  r2_key          TEXT    NOT NULL UNIQUE,
  mime            TEXT    NOT NULL,
  filename        TEXT    NOT NULL,
  size            INTEGER NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ========== 审计日志（只追加，带哈希链） ==========
-- 记录「哪个根假名做了什么」，不含真实身份、不含原始 IP。
-- 不提供 UPDATE/DELETE 路径；cron 不清理本表。
CREATE TABLE IF NOT EXISTS audit_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL DEFAULT (datetime('now')),
  actor_member_id INTEGER,                               -- NULL = 系统/cron
  actor_role      TEXT    NOT NULL DEFAULT 'system',
  action          TEXT    NOT NULL,
  target_type     TEXT,
  target_id       TEXT,
  detail          TEXT,                                  -- JSON，禁止写入 IP/原始身份
  prev_hash       TEXT    NOT NULL,
  hash            TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_member_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, ts);

-- 链头单例行：写入时以 CAS（WHERE hash = 读到的旧值）防止并发分叉。
CREATE TABLE IF NOT EXISTS audit_head (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  hash TEXT NOT NULL
);
INSERT INTO audit_head (id, hash) VALUES (1, 'GENESIS');

-- ========== 限流计数 ==========
-- key 为 SHA-256(IP + 当日盐) 或 member_id，原始 IP 不落盘。
-- 窗口过期时由 upsert 的 CASE 原地重开（沿用博客 login_attempts 的原子写法）。
-- 过期行由 cron 清理（见 src/cron.js）。
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  window_end   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_expiry ON rate_limits(window_end);
