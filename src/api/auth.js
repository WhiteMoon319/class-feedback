// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 注册与登录。核心约束：
//   - 注册必须持有一次性邀请码；邀请码原子核销，防并发重放
//   - 根假名注册时随机分配，全局唯一，仅本人与后端可见
//   - 恢复码注册时一次性展示，平台只存哈希；重置密码后旧恢复码作废
//   - 所有失败路径返回同一句提示，不泄露「该名字是否存在」

import { hashPassword, verifyPassword, randomCode, sha256Hex } from '../lib/crypto.js';
import { generateName } from '../lib/names.js';
import { signToken, setSessionCookie, clearSessionCookie } from '../lib/session.js';
import { requireMember, memberView } from '../lib/authz.js';
import { json, fail, readJson, strField, ApiError } from '../lib/http.js';
import { consume, ipKey } from '../lib/ratelimit.js';
import { writeAudit } from '../lib/audit.js';

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;

function formatRecoveryCode() {
  const c = randomCode(12);
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}

function checkPassword(value) {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    throw new ApiError(400, 'weak_password', `密码长度需在 ${PASSWORD_MIN}-${PASSWORD_MAX} 位之间`);
  }
  return value;
}

/** 自定义昵称校验；不填返回 null（由后端随机生成根假名）。
 *  规则：2-20 字符，仅中英文/数字/_-，不能纯数字（防「123456」当昵称） */
function normalizeDisplayName(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const name = String(raw).trim();
  if (name.length < 2 || name.length > 20) {
    throw new ApiError(400, 'invalid_field', '昵称长度需在 2-20 个字符之间');
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(name)) {
    throw new ApiError(400, 'invalid_field', '昵称只能包含中英文、数字、下划线或连字符');
  }
  if (/^\d+$/.test(name)) {
    throw new ApiError(400, 'invalid_field', '昵称不能是纯数字');
  }
  return name;
}

/** 邀请码原子核销：只有 used=0 → 1 的那一次请求能拿到 type/duty */
async function claimInvite(db, code) {
  const res = await db.batch([
    db.prepare('UPDATE invites SET used = 1 WHERE code = ? AND used = 0 RETURNING type, duty')
      .bind(code.toUpperCase()),
  ]);
  const row = res[0].results?.[0];
  if (!row) return null;
  return row;
}

async function releaseInvite(db, code) {
  await db.prepare('UPDATE invites SET used = 0 WHERE code = ? AND used = 1 AND used_by IS NULL')
    .bind(code.toUpperCase()).run();
}

export async function register(request, env) {
  const body = await readJson(request);
  const ipk = await ipKey(request, env.SESSION_SECRET);
  const limit = await consume(env.DB, `reg:${ipk}`, {
    max: Number(env.REGISTRATION_RATE_LIMIT_MAX) || 8,
    windowSec: Number(env.REGISTRATION_RATE_LIMIT_WINDOW) || 3600,
  });
  if (!limit.ok) return fail(429, 'rate_limited', `注册尝试过于频繁，请 ${limit.retryAfter} 秒后再试`);

  const code = strField(body, 'inviteCode', { max: 32 }).toUpperCase();
  const password = checkPassword(body.password);
  // 昵称在核销邀请码之前校验：无效输入不应烧掉一个码
  const customName = normalizeDisplayName(body.displayName);

  const invite = await claimInvite(env.DB, code);
  if (!invite) return fail(400, 'bad_invite', '邀请码无效或已被使用');

  const role = invite.type === 'owner' ? 'owner' : (invite.type === 'committee' ? 'committee' : 'student');
  const duty = role === 'committee' ? (invite.duty || '班委') : null;

  const isTaken = async (name) => !!(await env.DB.prepare('SELECT 1 AS x FROM members WHERE display_name = ?').bind(name).first());
  // 优先用用户自定义昵称；未提供则随机生成根假名
  const displayName = customName
    ? ((await isTaken(customName)) ? null : customName)
    : await generateName(isTaken);
  if (!displayName) return fail(409, 'name_taken', '这个昵称已被使用，换一个吧');

  const recoveryCode = formatRecoveryCode();

  let member;
  try {
    member = await env.DB.prepare(
      `INSERT INTO members (display_name, password_hash, recovery_hash, role, duty)
       VALUES (?, ?, ?, ?, ?) RETURNING id, session_version`,
    ).bind(
      displayName,
      await hashPassword(password),
      await hashPassword(recoveryCode),
      role,
      duty,
    ).first();
  } catch (e) {
    // 建号失败要把邀请码退回，否则同学白丢一个码
    await releaseInvite(env.DB, code);
    if (String(e?.message || '').includes('UNIQUE')) {
      return fail(409, 'name_taken', '假名分配冲突，请重试一次');
    }
    throw e;
  }

  await env.DB.prepare('UPDATE invites SET used_by = ? WHERE code = ?').bind(member.id, code.toUpperCase()).run();

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: role, action: 'register',
    targetType: 'invite', targetId: code, detail: { role, duty },
  });

  const token = await signToken(env.SESSION_SECRET, member.id, member.session_version);
  return setSessionCookie(
    json({
      ok: true,
      member: { displayName, role, duty },
      recoveryCode,
      warning: '请立即保存恢复码：这是唯一的密码找回凭据，平台不保留副本，关闭本页后不再显示。',
    }, 201),
    token,
  );
}

export async function login(request, env) {
  const body = await readJson(request);
  const name = strField(body, 'name', { max: 40 });
  const password = typeof body.password === 'string' ? body.password : '';

  const ipk = await ipKey(request, env.SESSION_SECRET);
  const [byIp, byName] = await Promise.all([
    consume(env.DB, `login:${ipk}`, {
      max: Number(env.LOGIN_RATE_LIMIT_MAX) || 10,
      windowSec: Number(env.LOGIN_RATE_LIMIT_WINDOW) || 300,
    }),
    consume(env.DB, `login:name:${await sha256Hex(name.toLowerCase())}`, {
      max: Number(env.LOGIN_NAME_RATE_LIMIT_MAX) || 5,
      windowSec: Number(env.LOGIN_NAME_RATE_LIMIT_WINDOW) || 900,
    }),
  ]);
  if (!byIp.ok || !byName.ok) {
    const wait = Math.max(byIp.retryAfter, byName.retryAfter);
    return fail(429, 'rate_limited', `登录尝试过于频繁，请 ${wait} 秒后再试`);
  }

  const member = await env.DB.prepare(
    'SELECT id, display_name, password_hash, role, duty, session_version, banned FROM members WHERE display_name = ?',
  ).bind(name).first();

  // 名字不存在与密码错误返回同一提示，避免枚举假名
  const ok = member && !member.banned && (await verifyPassword(password, member.password_hash));
  if (!ok) {
    if (member) {
      await writeAudit(env.DB, {
        actorMemberId: member.id, actorRole: 'system', action: 'login_fail',
        targetType: 'member', targetId: member.id,
      });
    }
    return fail(401, 'bad_credentials', '假名或密码不正确');
  }

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: member.role, action: 'login',
    targetType: 'member', targetId: member.id,
  });

  const token = await signToken(env.SESSION_SECRET, member.id, member.session_version);
  return setSessionCookie(json({ ok: true, member: memberView(member) }), token);
}

export async function logout(request, env) {
  const member = await loadOrNull(request, env);
  if (member) {
    await writeAudit(env.DB, {
      actorMemberId: member.id, actorRole: member.role, action: 'logout',
      targetType: 'member', targetId: member.id,
    });
  }
  return clearSessionCookie(json({ ok: true }));
}

async function loadOrNull(request, env) {
  try { return await requireMember(request, env); } catch { return null; }
}

export async function me(request, env) {
  // 信息性接口：匿名返回 member:null（200），不产生 401 噪音；
  // 认证失败（过期/版本不匹配）同样视为未登录
  const member = await loadMemberForMe(request, env);
  if (!member) return json({ ok: true, member: null, myFeedbackCount: 0 });
  const mine = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM feedbacks WHERE member_id = ?',
  ).bind(member.id).first();
  return json({ ok: true, member: memberView(member), myFeedbackCount: mine?.n ?? 0 });
}

async function loadMemberForMe(request, env) {
  try { return await requireMember(request, env); } catch { return null; }
}

export async function resetPassword(request, env) {
  const body = await readJson(request);
  const name = strField(body, 'name', { max: 40 });
  const recoveryCode = strField(body, 'recoveryCode', { max: 32 });
  const password = checkPassword(body.password);

  const ipk = await ipKey(request, env.SESSION_SECRET);
  const limit = await consume(env.DB, `reset:${ipk}`, { max: 5, windowSec: 3600 });
  if (!limit.ok) return fail(429, 'rate_limited', `重置尝试过于频繁，请 ${limit.retryAfter} 秒后再试`);

  const member = await env.DB.prepare(
    'SELECT id, recovery_hash, session_version FROM members WHERE display_name = ?',
  ).bind(name).first();
  if (!member || !(await verifyPassword(recoveryCode.toUpperCase(), member.recovery_hash))) {
    return fail(401, 'bad_recovery', '假名或恢复码不正确');
  }

  const newRecovery = formatRecoveryCode();
  const nextVersion = member.session_version + 1; // 旧 cookie 与旧恢复码同时作废
  await env.DB.prepare(
    'UPDATE members SET password_hash = ?, recovery_hash = ?, session_version = ? WHERE id = ?',
  ).bind(
    await hashPassword(password),
    await hashPassword(newRecovery),
    nextVersion,
    member.id,
  ).run();

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: 'system', action: 'password_reset',
    targetType: 'member', targetId: member.id,
  });

  return json({
    ok: true,
    recoveryCode: newRecovery,
    warning: '密码已重置，旧恢复码同时作废。请保存新的恢复码。',
  });
}
