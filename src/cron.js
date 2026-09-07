// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 定时任务（每日一次）：
//   1. 过期未使用的邀请码标记作废（used = -1，区别于 0 未用 / 1 已用）
//   2. 清理已过窗口的限流计数行
// 审计日志永不清理。

const INVITE_TTL_DAYS = 14;

export async function runMaintenance(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - INVITE_TTL_DAYS * 86400_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const epoch = Math.floor(now.getTime() / 1000);

  const [expired, cleaned] = await db.batch([
    db.prepare('UPDATE invites SET used = -1 WHERE used = 0 AND created_at < ?').bind(cutoff),
    db.prepare('DELETE FROM rate_limits WHERE window_end < ?').bind(epoch),
  ]);

  return { invitesVoided: expired.meta?.changes ?? 0, rateRowsCleaned: cleaned.meta?.changes ?? 0 };
}

export { INVITE_TTL_DAYS };
