// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 限流：基于 D1 的原子单语句 upsert（沿用博客 login_attempts 的写法）。
// 并发请求由 SQLite 写事务串行化，不会丢失计数更新；
// 存储不可用时 fail-open（放行并告警），避免整站因限流故障而不可用。
//
// 隐私约束：key 只允许是 SHA-256(IP + 当日盐) 或 member_id，原始 IP 不落盘。

const DEFAULT_MAX = 10;
const DEFAULT_WINDOW = 300;

/** 从请求取原始 IP —— 仅在内存中使用，绝不写入日志或数据库 */
export function clientIp(request) {
  // 生产流量必经 Cloudflare 边缘，CF-Connecting-IP 恒存在，取它即可。
  // 缺失时（本地开发、直连回源、绕过 CF 的请求）不信任 X-Forwarded-For：
  // 该头可由客户端任意伪造，作为限流键会被轻易绕过。此时退化为固定键
  // （未知来源共享一个配额桶），宁可误伤也不放开伪造入口。
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf && cf.trim()) return cf.trim();
  return 'unknown';
}

/** 当日盐由会话密钥 + 日期构成：跨天自动换键，旧行随之过期被 cron 清理 */
export async function ipKey(request, secret) {
  const day = new Date().toISOString().slice(0, 10);
  const { sha256Hex } = await import('./crypto.js');
  return `ip:${await sha256Hex(`${secret}|${day}|${clientIp(request)}`)}`;
}

export async function memberKey(memberId) {
  return `m:${memberId}`;
}

/**
 * 消费一次配额。
 * @returns {Promise<{ok: boolean, retryAfter: number, remaining: number}>}
 */
export async function consume(db, key, opts = {}) {
  const max = opts.max && opts.max > 0 ? opts.max : DEFAULT_MAX;
  const windowSec = opts.windowSec && opts.windowSec > 0 ? opts.windowSec : DEFAULT_WINDOW;
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + windowSec;

  try {
    const [attempt] = await db.batch([
      db.prepare(
        `INSERT INTO rate_limits (key, count, window_start, window_end)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_end <= ? THEN 1 ELSE rate_limits.count + 1 END,
           window_start = CASE WHEN rate_limits.window_end <= ? THEN ? ELSE rate_limits.window_start END,
           window_end = CASE WHEN rate_limits.window_end <= ? THEN ? ELSE rate_limits.window_end END
         RETURNING count, window_end`,
      ).bind(key, now, windowEnd, now, now, now, now, windowEnd),
      db.prepare('DELETE FROM rate_limits WHERE window_end < ?').bind(now),
    ]);
    const row = attempt.results?.[0];
    const count = row?.count ?? 1;
    if (count > max) {
      return { ok: false, retryAfter: Math.max(1, (row?.window_end ?? windowEnd) - now), remaining: 0 };
    }
    return { ok: true, retryAfter: 0, remaining: max - count };
  } catch (e) {
    console.error('[ratelimit] 存储异常，本次放行:', e);
    return { ok: true, retryAfter: 0, remaining: max };
  }
}
