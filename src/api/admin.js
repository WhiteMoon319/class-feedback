// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 管理端：邀请码、举报处理、封禁、内容隐藏、审计日志。
//
// 权限分层（匿名性的护栏所在）：
//   - 学生码：班委可生成（日常发群注册用）
//   - 班委码/维护者码：仅站点维护者可生成（权力授予最小化，班委不得自行扩权）
//   - 班委：处理举报（隐藏/驳回）、回复与发公告；无封禁权
//   - 维护者：全量审计日志、校验哈希链、封禁/解封、经举报处理执行封禁
//   - 举报详情是根假名唯一被允许出现在界面上的地方（封禁必须知道封谁）；
//     日常反馈列表绝不出现根假名。

import { requireStaff, requireOwner } from '../lib/authz.js';
import { randomCode } from '../lib/crypto.js';
import { json, fail, readJson, strField, intParam, oneOf } from '../lib/http.js';
import { writeAudit, verifyChain } from '../lib/audit.js';
import { INVITE_TTL_DAYS } from '../cron.js';

const INVITE_TYPES = ['student', 'committee', 'owner'];

function inviteCode() {
  return `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
}

export async function createInvites(request, env) {
  // 先完成基础鉴权（至少班委），再按邀请码类型收紧：
  // 学生码班委可发；班委码与维护者码仅 owner 可发。
  const staff = await requireStaff(request, env);
  const body = await readJson(request);
  const type = oneOf(body.type, INVITE_TYPES, '邀请码类型');
  if (type !== 'student' && staff.role !== 'owner') {
    return fail(403, 'forbidden', '仅站点维护者可生成班委码与维护者码');
  }
  const count = Math.min(50, Math.max(1, Number(body.count) || 1));
  const duty = type === 'committee' ? strField(body, 'duty', { min: 1, max: 20 }) : null;

  const codes = [];
  const stmts = [];
  for (let i = 0; i < count; i++) {
    const code = inviteCode();
    codes.push(code);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO invites (code, type, duty, expires_at)
         VALUES (?, ?, ?, datetime('now', '+${INVITE_TTL_DAYS} days'))`,
      ).bind(code, type, duty),
    );
  }
  await env.DB.batch(stmts);

  await writeAudit(env.DB, {
    actorMemberId: staff.id, actorRole: staff.role, action: 'invite_create',
    targetType: 'invite', detail: { type, duty, count },
  });
  return json({ ok: true, type, duty, expiresDays: INVITE_TTL_DAYS, codes }, 201);
}

export async function listInvites(request, env, url) {
  await requireStaff(request, env);
  const onlyUnused = url.searchParams.get('unused') === '1';
  const rows = await env.DB.prepare(
    `SELECT code, type, duty, used, created_at, expires_at FROM invites
     ${onlyUnused ? 'WHERE used = 0' : ''} ORDER BY created_at DESC, code LIMIT 200`,
  ).all();
  return json({
    ok: true,
    items: (rows.results ?? []).map((r) => ({
      code: r.code, type: r.type, duty: r.duty,
      state: r.used === 0 ? 'unused' : r.used === 1 ? 'used' : 'void',
      createdAt: r.created_at, expiresAt: r.expires_at,
    })),
  });
}

export async function voidInvite(request, env, url, params) {
  const staff = await requireStaff(request, env);
  const code = String(params.code || '').toUpperCase();
  const res = await env.DB.prepare('UPDATE invites SET used = -1 WHERE code = ? AND used = 0').bind(code).run();
  if (!res.meta.changes) return fail(404, 'not_found', '邀请码不存在或已不可作废');
  await writeAudit(env.DB, {
    actorMemberId: staff.id, actorRole: staff.role, action: 'invite_void',
    targetType: 'invite', targetId: code,
  });
  return json({ ok: true });
}

/** 举报列表：唯一允许展示根假名的界面 */
export async function listReports(request, env, url) {
  await requireStaff(request, env);
  const handled = url.searchParams.get('handled');
  const where = handled === null ? '1 = 1' : 'r.handled = ?';
  const binds = handled === null ? [] : [handled === '1' ? 1 : 0];

  const rows = await env.DB.prepare(
    `SELECT r.id, r.target_type, r.target_id, r.reason, r.handled, r.created_at,
            CASE r.target_type
              WHEN 'feedback' THEN f.title
              ELSE (SELECT fb.title FROM replies rr JOIN feedbacks fb ON fb.id = rr.feedback_id WHERE rr.id = r.target_id)
            END AS target_title,
            CASE r.target_type
              WHEN 'feedback' THEN f.body
              ELSE (SELECT rr2.body FROM replies rr2 WHERE rr2.id = r.target_id)
            END AS target_body,
            CASE r.target_type
              WHEN 'feedback' THEN f.alias
              ELSE (SELECT rr3.display_name FROM replies rr3 WHERE rr3.id = r.target_id)
            END AS target_alias,
            CASE r.target_type
              WHEN 'feedback' THEN fm.display_name
              ELSE (SELECT rm.display_name FROM replies rr4 JOIN members rm ON rm.id = rr4.member_id WHERE rr4.id = r.target_id)
            END AS target_root,
            CASE r.target_type
              WHEN 'feedback' THEN f.member_id
              ELSE (SELECT rr5.member_id FROM replies rr5 WHERE rr5.id = r.target_id)
            END AS target_member_id
     FROM reports r
     LEFT JOIN feedbacks f ON r.target_type = 'feedback' AND f.id = r.target_id
     LEFT JOIN members fm ON fm.id = f.member_id
     WHERE ${where} ORDER BY r.id DESC LIMIT 100`,
  ).bind(...binds).all();

  return json({
    ok: true,
    items: (rows.results ?? []).map((r) => ({
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.reason,
      handled: !!r.handled,
      createdAt: r.created_at,
      target: {
        title: r.target_title, body: r.target_body,
        alias: r.target_alias, rootName: r.target_root, memberId: r.target_member_id,
      },
    })),
  });
}

export async function handleReport(request, env, url, params) {
  const staff = await requireStaff(request, env);
  const id = intParam(params.id, '举报编号');
  const body = await readJson(request);
  const action = oneOf(body.action, ['dismiss', 'hide', 'ban'], '处理动作');
  // 封禁是最高等级处置：班委只能隐藏/驳回，执行封禁仅限维护者
  // （与 setBan 同一权限口径，防止班委借举报处理绕过封禁权限）
  if (action === 'ban' && staff.role !== 'owner') {
    return fail(403, 'forbidden', '仅站点维护者可执行封禁');
  }

  const report = await env.DB.prepare(
    'SELECT id, target_type, target_id, handled FROM reports WHERE id = ?',
  ).bind(id).first();
  if (!report) return fail(404, 'not_found', '举报不存在');
  if (report.handled) return fail(409, 'already_handled', '该举报已处理');

  const targetMember = await env.DB.prepare(
    report.target_type === 'feedback'
      ? 'SELECT member_id FROM feedbacks WHERE id = ?'
      : 'SELECT member_id FROM replies WHERE id = ?',
  ).bind(report.target_id).first();

  const stmts = [];
  if (action === 'hide') {
    stmts.push(report.target_type === 'feedback'
      ? env.DB.prepare('UPDATE feedbacks SET hidden = 1 WHERE id = ?').bind(report.target_id)
      : env.DB.prepare('UPDATE replies SET hidden = 1 WHERE id = ?').bind(report.target_id));
  }
  if (action === 'ban' && targetMember?.member_id) {
    stmts.push(env.DB.prepare('UPDATE members SET banned = 1, session_version = session_version + 1 WHERE id = ?')
      .bind(targetMember.member_id));
  }
  stmts.push(env.DB.prepare('UPDATE reports SET handled = 1 WHERE id = ?').bind(id));
  await env.DB.batch(stmts);

  await writeAudit(env.DB, {
    actorMemberId: staff.id, actorRole: staff.role, action: `report_${action}`,
    targetType: 'report', targetId: id,
    detail: { target_type: report.target_type, target_id: report.target_id, bannedMemberId: action === 'ban' ? targetMember?.member_id : undefined },
  });
  return json({ ok: true, action });
}

/** 封禁/解封：仅维护者。解封同时保留原根假名，历史反馈不受影响 */
export async function setBan(request, env, url, params) {
  const owner = await requireOwner(request, env);
  const id = intParam(params.id, '成员编号');
  const body = await readJson(request);
  const banned = body.banned === true ? 1 : 0;

  const member = await env.DB.prepare('SELECT id, display_name, role, banned FROM members WHERE id = ?').bind(id).first();
  if (!member) return fail(404, 'not_found', '成员不存在');
  if (member.role === 'owner') return fail(403, 'forbidden', '不能封禁维护者账号');

  await env.DB.prepare('UPDATE members SET banned = ?, session_version = session_version + 1 WHERE id = ?')
    .bind(banned, id).run();

  await writeAudit(env.DB, {
    actorMemberId: owner.id, actorRole: 'owner', action: banned ? 'member_ban' : 'member_unban',
    targetType: 'member', targetId: id, detail: { displayName: member.display_name },
  });
  return json({ ok: true, banned: !!banned });
}

export async function hideFeedback(request, env, url, params) {
  const staff = await requireStaff(request, env);
  const id = intParam(params.id, '反馈编号');
  const body = await readJson(request);
  const hidden = body.hidden === false ? 0 : 1;

  const res = await env.DB.prepare('UPDATE feedbacks SET hidden = ? WHERE id = ?').bind(hidden, id).run();
  if (!res.meta.changes) return fail(404, 'not_found', '反馈不存在');
  await writeAudit(env.DB, {
    actorMemberId: staff.id, actorRole: staff.role, action: hidden ? 'feedback_hide' : 'feedback_unhide',
    targetType: 'feedback', targetId: id,
  });
  return json({ ok: true, hidden: !!hidden });
}

/**
 * 审计日志查询。
 * 班委只能取回 actor_member_id 为本人的行；全量仅维护者可查。
 * 返回的 displayName 是根假名——因此该接口本身就受权限限制。
 */
export async function listAudit(request, env, url) {
  const staff = await requireStaff(request, env);
  const isOwner = staff.role === 'owner';
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const action = url.searchParams.get('action');

  const where = [];
  const binds = [];
  if (isOwner) {
    const actor = url.searchParams.get('actor');
    if (actor) { where.push('l.actor_member_id = ?'); binds.push(intParam(actor, '成员编号')); }
  } else {
    where.push('l.actor_member_id = ?');
    binds.push(staff.id);
  }
  if (action) { where.push('l.action = ?'); binds.push(action); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await env.DB.prepare(
    `SELECT l.id, l.ts, l.actor_member_id, l.actor_role, l.action, l.target_type, l.target_id, l.detail,
            m.display_name AS actor_name
     FROM audit_logs l LEFT JOIN members m ON m.id = l.actor_member_id
     ${clause} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all();

  return json({
    ok: true,
    scope: isOwner ? 'all' : 'self',
    items: (rows.results ?? []).map((r) => ({
      id: r.id, ts: r.ts, actorName: r.actor_name ?? null, actorRole: r.actor_role,
      action: r.action, targetType: r.target_type, targetId: r.target_id,
      detail: r.detail ? JSON.parse(r.detail) : null,
    })),
    limit, offset,
  });
}

export async function checkChain(request, env) {
  await requireOwner(request, env);
  const result = await verifyChain(env.DB);
  return json({ ok: true, chain: result });
}
