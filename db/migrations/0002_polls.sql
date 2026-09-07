-- 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- 投票（决议的实质）。
--   polls.options        JSON 数组，如 ["支持","反对","弃权"]
--   poll_votes           一人一票：PK(poll_id, member_id)，重复投票=改票（覆盖 option_index）
--   截止状态实时判定：expires_at 与当前时间比较，不依赖 cron
--   hide_results=1 时截止前不返回任何票数；截止后全部公开
--   投票者身份对外不可见（匿名天然成立），member_id 仅用于一人一票与改票

CREATE TABLE IF NOT EXISTS polls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  created_by   INTEGER NOT NULL REFERENCES members(id),
  created_duty TEXT NOT NULL,                          -- 发起人职务快照
  options      TEXT NOT NULL,                          -- JSON 数组
  hide_results INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,                          -- UTC
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_polls_created ON polls(created_at DESC);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id      INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  member_id    INTEGER NOT NULL REFERENCES members(id),
  option_index INTEGER NOT NULL CHECK (option_index >= 0),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (poll_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_poll ON poll_votes(poll_id);
