// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 反馈工单流。匿名性的关键在这里：
//   - 每条反馈提交时独立随机一个「笔名」对外展示，同一人的不同反馈无法被浏览者关联
//   - 同一反馈下的学生补充回复沿用该反馈笔名，保证对话连贯
//   - 班委回复署职务，可按条自选匿名（显示「班委」）
//   - 任何响应体都不出现 member_id / display_name（根假名）

import { requireMember, requireCommittee } from '../lib/authz.js';
import { generateName } from '../lib/names.js';
import { json, fail, readJson, strField, intParam, oneOf, ApiError } from '../lib/http.js';
import { consume, ipKey, memberKey } from '../lib/ratelimit.js';
import { writeAudit } from '../lib/audit.js';

const TITLE_MAX = 60;
const BODY_MAX = 4000;
const REPLY_MAX = 2000;
const STATUSES = ['pending', 'in_review', 'resolved'];

const STATUS_TEXT = { pending: '待处理', in_review: '处理中', resolved: '已解决' };

async function aliasTaken(db, name) {
  return !!(await db.prepare('SELECT 1 AS x FROM feedbacks WHERE alias = ?').bind(name).first());
}

function pageParams(url) {
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  return { limit, offset };
}

/** 公开视图：只保留展示字段 */
function feedbackView(row) {
  return {
    id: row.id,
    alias: row.alias,
    title: row.title,
    status: row.status,
    statusText: STATUS_TEXT[row.status],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function replyView(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    isCommittee: !!row.is_committee,
    body: row.body,
    createdAt: row.created_at,
  };
}

export async function listFeedbacks(request, env, url) {
  const { limit, offset } = pageParams(url);
  const status = url.searchParams.get('status');
  const where = ['hidden = 0'];
  const binds = [];
  if (status && STATUSES.includes(status)) { where.push('status = ?'); binds.push(status); }

  const rows = await env.DB.prepare(
    `SELECT id, alias, title, status, created_at, updated_at,
            (SELECT COUNT(*) FROM replies r WHERE r.feedback_id = f.id AND r.hidden = 0) AS reply_count
     FROM feedbacks f WHERE ${where.join(' AND ')}
     ORDER BY (status = 'resolved'), updated_at DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feedbacks WHERE ${where.join(' AND ')}`,
  ).bind(...binds).first();

  return json({
    ok: true,
    items: (rows.results ?? []).map((r) => ({ ...feedbackView(r), replyCount: r.reply_count })),
    total: total?.n ?? 0,
    limit,
    offset,
  });
}

export async function getFeedback(request, env, url, params) {
  const id = intParam(params.id, '反馈编号');
  const row = await env.DB.prepare(
    'SELECT id, alias, title, body, status, hidden, created_at, updated_at FROM feedbacks WHERE id = ?',
  ).bind(id).first();
  if (!row || row.hidden) return fail(404, 'not_found', '该反馈不存在或已下架');

  const replies = await env.DB.prepare(
    'SELECT id, is_committee, anonymous, display_name, body, created_at FROM replies WHERE feedback_id = ? AND hidden = 0 ORDER BY id ASC',
  ).bind(id).all();

  return json({ ok: true, feedback: { ...feedbackView(row), body: row.body }, replies: (replies.results ?? []).map(replyView) });
}

/** 我的反馈：按根假名聚合，仅本人可见，因此可以带正文与笔名 */
export async function myFeedbacks(request, env, url) {
  const member = await requireMember(request, env);
  const { limit, offset } = pageParams(url);
  const rows = await env.DB.prepare(
    `SELECT id, alias, title, body, status, created_at, updated_at,
            (SELECT COUNT(*) FROM replies r WHERE r.feedback_id = f.id AND r.hidden = 0) AS reply_count
     FROM feedbacks f WHERE member_id = ? AND hidden = 0 ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).bind(member.id, limit, offset).all();
  return json({
    ok: true,
    items: (rows.results ?? []).map((r) => ({ ...feedbackView(r), body: r.body, replyCount: r.reply_count })),
    limit,
    offset,
  });
}

/** 作者撤回自己的反馈：已有班委回复时禁止（避免班委工作被抹掉）。
 *  连带清理相关举报，审计日志保留撤回记录。 */
export async function deleteFeedback(request, env, url, params) {
  const member = await requireMember(request, env);
  const id = intParam(params.id, '反馈编号');

  const fb = await env.DB.prepare(
    'SELECT id, member_id, alias, title FROM feedbacks WHERE id = ?',
  ).bind(id).first();
  if (!fb) return fail(404, 'not_found', '反馈不存在');
  if (fb.member_id !== member.id) return fail(403, 'forbidden', '只能撤回自己提交的反馈');

  const committeeReply = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM replies WHERE feedback_id = ? AND is_committee = 1',
  ).bind(id).first();
  if ((committeeReply?.n ?? 0) > 0) {
    return fail(403, 'has_reply', '班委已回复，无法撤回；如需删除请联系班委处理');
  }

  // 清理指向该反馈及其回复的举报，再删除反馈（回复由外键级联删除）
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM reports WHERE (target_type = 'feedback' AND target_id = ?)
        OR (target_type = 'reply' AND target_id IN (SELECT id FROM replies WHERE feedback_id = ?))`,
    ).bind(id, id),
    env.DB.prepare('DELETE FROM feedbacks WHERE id = ?').bind(id),
  ]);

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: member.role, action: 'feedback_withdraw',
    targetType: 'feedback', targetId: id, detail: { alias: fb.alias, title: fb.title },
  });
  return json({ ok: true });
}

export async function createFeedback(request, env) {
  const member = await requireMember(request, env);
  if (member.banned) return fail(403, 'banned', '账号已被封禁');

  const body = await readJson(request);
  const title = strField(body, 'title', { min: 2, max: TITLE_MAX });
  const text = strField(body, 'body', { min: 5, max: BODY_MAX });

  const ipk = await ipKey(request, env.SESSION_SECRET);
  const [byMember, byIp] = await Promise.all([
    consume(env.DB, `fb:${await memberKey(member.id)}`, {
      max: Number(env.SUBMIT_RATE_LIMIT_MAX) || 10,
      windowSec: Number(env.SUBMIT_RATE_LIMIT_WINDOW) || 3600,
    }),
    consume(env.DB, `fbip:${ipk}`, { max: 20, windowSec: 3600 }),
  ]);
  if (!byMember.ok || !byIp.ok) {
    return fail(429, 'rate_limited', `提交过于频繁，请 ${Math.max(byMember.retryAfter, byIp.retryAfter)} 秒后再试`);
  }

  const alias = await generateName((name) => aliasTaken(env.DB, name));

  const created = await env.DB.prepare(
    'INSERT INTO feedbacks (member_id, alias, title, body) VALUES (?, ?, ?, ?) RETURNING id, created_at, status',
  ).bind(member.id, alias, title, text).first();

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: member.role, action: 'feedback_create',
    targetType: 'feedback', targetId: created.id, detail: { alias },
  });

  return json({ ok: true, id: created.id, alias }, 201);
}

export async function addReply(request, env, url, params) {
  const member = await requireMember(request, env);
  const feedbackId = intParam(params.id, '反馈编号');
  const body = await readJson(request);
  const text = strField(body, 'body', { min: 1, max: REPLY_MAX });
  const anonymous = body.anonymous === true;

  const fb = await env.DB.prepare(
    'SELECT id, member_id, alias, status, hidden FROM feedbacks WHERE id = ?',
  ).bind(feedbackId).first();
  if (!fb || fb.hidden) return fail(404, 'not_found', '该反馈不存在或已下架');

  const isOwner = fb.member_id === member.id;
  const isCommittee = member.role === 'committee';
  if (!isOwner && !isCommittee) {
    return fail(403, 'forbidden', '只有反馈作者或班委可以回复');
  }

  // 展示名口径：班委匿名 → 「班委」；班委实名 → 职务；学生 → 该反馈的笔名
  let displayName;
  if (isCommittee) displayName = anonymous ? '班委' : (member.duty || '班委');
  else displayName = fb.alias;

  const [created] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO replies (feedback_id, member_id, is_committee, anonymous, display_name, body)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id, display_name, is_committee, anonymous, created_at`,
    ).bind(feedbackId, member.id, isCommittee ? 1 : 0, isCommittee && anonymous ? 1 : 0, displayName, text),
    env.DB.prepare("UPDATE feedbacks SET updated_at = datetime('now'), status = CASE WHEN status = 'pending' AND ? THEN 'in_review' ELSE status END WHERE id = ?")
      .bind(isCommittee ? 1 : 0, feedbackId),
  ]);

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: member.role, action: 'reply_create',
    targetType: 'reply', targetId: created.results?.[0]?.id,
    detail: { feedbackId, displayName, anonymous: !!(isCommittee && anonymous) },
  });

  const row = created.results?.[0];
  return json({ ok: true, reply: replyView(row) }, 201);
}

export async function updateStatus(request, env, url, params) {
  const member = await requireCommittee(request, env);
  const id = intParam(params.id, '反馈编号');
  const body = await readJson(request);
  const status = oneOf(body.status, STATUSES, '状态');

  const before = await env.DB.prepare('SELECT id, status, hidden FROM feedbacks WHERE id = ?').bind(id).first();
  if (!before || before.hidden) return fail(404, 'not_found', '该反馈不存在或已下架');
  if (before.status === status) return json({ ok: true, status });

  await env.DB.batch([
    env.DB.prepare("UPDATE feedbacks SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id),
    env.DB.prepare(
      `INSERT INTO replies (feedback_id, member_id, is_committee, anonymous, display_name, body)
       VALUES (?, ?, 1, 0, ?, ?)`,
    ).bind(id, member.id, member.duty || '班委', `【状态更新】${STATUS_TEXT[status]}`),
  ]);

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: 'committee', action: 'feedback_status',
    targetType: 'feedback', targetId: id, detail: { from: before.status, to: status },
  });
  return json({ ok: true, status });
}

export async function reportContent(request, env, url, params) {
  const member = await requireMember(request, env);
  const id = intParam(params.id, '反馈编号');
  const body = await readJson(request);
  const targetType = oneOf(body.targetType, ['feedback', 'reply'], '举报对象类型');
  const targetId = intParam(body.targetId, '举报对象编号');
  const reason = strField(body, 'reason', { min: 2, max: 500 });

  const fb = await env.DB.prepare('SELECT id FROM feedbacks WHERE id = ?').bind(id).first();
  if (!fb) return fail(404, 'not_found', '该反馈不存在或已下架');

  // 举报对象必须真实存在且属于该反馈，防随意构造 targetId
  if (targetType === 'reply') {
    const reply = await env.DB.prepare(
      'SELECT id FROM replies WHERE id = ? AND feedback_id = ?',
    ).bind(targetId, id).first();
    if (!reply) return fail(400, 'invalid_field', '举报的回复不存在或不属于该反馈');
  }

  const limit = await consume(env.DB, `report:${member.id}`, { max: 10, windowSec: 3600 });
  if (!limit.ok) return fail(429, 'rate_limited', `举报过于频繁，请 ${limit.retryAfter} 秒后再试`);

  const created = await env.DB.prepare(
    'INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?) RETURNING id',
  ).bind(member.id, targetType, targetId, reason).first();

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: member.role, action: 'report_create',
    targetType: 'report', targetId: created.id, detail: { target_type: targetType, target_id: targetId },
  });
  return json({ ok: true, id: created.id }, 201);
}

export { STATUS_TEXT };
