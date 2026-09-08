// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 邀请码公开预校验：同学点开邀请链接时先查一次状态，避免白填表单。
//
// 隐私边界（重要）：本接口对游客开放，因此只返回 state/type/duty，
// 绝不返回 used_by——否则邀请码会与注册者昵称关联，破坏匿名模型。
// 码不可枚举（12 位 32 字符集），仍叠加 IP 限流防止被当作探测接口滥用。

import { json, fail } from '../lib/http.js';
import { consume, ipKey } from '../lib/ratelimit.js';

const CODE_PATTERN = /^[A-Z0-9-]{6,32}$/;

function nowUtc() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export async function checkInvite(request, env, url, params) {
  const ipk = await ipKey(request, env.SESSION_SECRET);
  const limit = await consume(env.DB, `invitecheck:${ipk}`, {
    max: Number(env.INVITE_CHECK_RATE_LIMIT_MAX) || 30,
    windowSec: 3600,
  });
  if (!limit.ok) return fail(429, 'rate_limited', `查询过于频繁，请 ${limit.retryAfter} 秒后再试`);

  const raw = params.code || url.searchParams.get('code') || '';
  const code = String(raw).trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) return json({ ok: true, state: 'not_found' });

  const row = await env.DB.prepare(
    'SELECT type, duty, used, expires_at FROM invites WHERE code = ?',
  ).bind(code).first();

  if (!row) return json({ ok: true, state: 'not_found' });
  if (row.used === 1) return json({ ok: true, state: 'used' });
  if (row.used === -1) return json({ ok: true, state: 'void' });
  if (row.expires_at && row.expires_at <= nowUtc()) return json({ ok: true, state: 'expired' });

  return json({ ok: true, state: 'available', type: row.type, duty: row.duty || null });
}
