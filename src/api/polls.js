// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 投票。语义要点：
//   - 一人一票（member_id 维度），截止前可改票（upsert 覆盖）
//   - 截止状态实时判定：now >= expires_at → closed
//   - hide_results=1 时，截止前不返回任何票数（包括总票数），截止后全公开
//   - 任何响应都不含投票者身份；member_id 仅用于去重，不对外
//   - 投票与改票均写审计日志（记录 poll_id，不含投了谁）

import { requireMember, requireStaff } from '../lib/authz.js';
import { json, fail, readJson, strField, intParam } from '../lib/http.js';
import { writeAudit } from '../lib/audit.js';

const OPTIONS_MIN = 2;
const OPTIONS_MAX = 10;
const OPTION_TEXT_MAX = 50;

function nowUtc() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function isOpen(poll) {
  return poll.expires_at > nowUtc();
}

function parseOptions(raw) {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length < OPTIONS_MIN || arr.length > OPTIONS_MAX) return null;
    if (arr.some((o) => typeof o !== 'string' || !o.trim() || o.trim().length > OPTION_TEXT_MAX)) return null;
    return arr.map((o) => o.trim());
  } catch { return null; }
}

/** 组装对外视图。session 存在时附带 myVote（当前账号的选项下标） */
async function pollView(db, row, memberId) {
  const open = isOpen(row);
  const options = JSON.parse(row.options);
  const counts = new Array(options.length).fill(0);

  if (!(row.hide_results && open)) {
    const rows = await db.prepare(
      'SELECT option_index, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_index',
    ).bind(row.id).all();
    for (const r of rows.results ?? []) counts[r.option_index] = r.n;
  }
  const total = counts.reduce((a, b) => a + b, 0);

  let myVote = null;
  if (memberId) {
    const mine = await db.prepare(
      'SELECT option_index FROM poll_votes WHERE poll_id = ? AND member_id = ?',
    ).bind(row.id, memberId).first();
    myVote = mine?.option_index ?? null;
  }

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    duty: row.created_duty,
    status: open ? 'open' : 'closed',
    statusText: open ? '进行中' : '已结束',
    hideResults: !!row.hide_results,
    options: options.map((text, i) => ({ text, votes: counts[i] })),
    totalVotes: total,
    myVote,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function listPolls(request, env, url) {
  const rows = await env.DB.prepare(
    'SELECT id, title, description, created_duty, options, hide_results, expires_at, created_at FROM polls ORDER BY created_at DESC LIMIT 50',
  ).all();
  const items = [];
  for (const row of rows.results ?? []) {
    items.push(await pollView(env.DB, row, null));
  }
  return json({ ok: true, items });
}

export async function getPoll(request, env, url, params) {
  const id = intParam(params.id, '投票编号');
  const row = await env.DB.prepare(
    'SELECT id, title, description, created_duty, options, hide_results, expires_at, created_at FROM polls WHERE id = ?',
  ).bind(id).first();
  if (!row) return fail(404, 'not_found', '投票不存在');

  let memberId = null;
  try { memberId = (await requireMember(request, env))?.id; } catch { /* 游客 */ }
  return json({ ok: true, poll: await pollView(env.DB, row, memberId) });
}

export async function createPoll(request, env) {
  const staff = await requireStaff(request, env);
  const body = await readJson(request);
  const title = strField(body, 'title', { min: 2, max: 60 });
  const description = strField(body, 'description', { min: 0, max: 800, required: false });
  const hideResults = body.hideResults === true ? 1 : 0;

  if (!Array.isArray(body.options) || body.options.length < OPTIONS_MIN || body.options.length > OPTIONS_MAX) {
    return fail(400, 'invalid_field', `选项需为 ${OPTIONS_MIN}-${OPTIONS_MAX} 个`);
  }
  const options = body.options.map((o) => String(o).trim());
  if (options.some((o) => !o || o.length > OPTION_TEXT_MAX)) {
    return fail(400, 'invalid_field', `每个选项 1-${OPTION_TEXT_MAX} 字`);
  }
  if (new Set(options).size !== options.length) {
    return fail(400, 'invalid_field', '选项不能重复');
  }

  const expiresAt = strField(body, 'expiresAt', { min: 1, max: 30 });
  // 兼容两种输入：本地时间 "YYYY-MM-DD[T ]HH:MM(:SS)"（按 +08:00）或带时区 ISO
  let expiresUtc;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(expiresAt);
  if (m) {
    const sec = m[3] ?? '00';
    expiresUtc = new Date(`${m[1]}T${m[2]}:${sec}+08:00`);
  } else {
    expiresUtc = new Date(expiresAt);
  }
  if (Number.isNaN(expiresUtc.getTime())) return fail(400, 'invalid_field', '截止时间格式不正确');
  if (expiresUtc.getTime() <= Date.now() + 60_000) return fail(400, 'invalid_field', '截止时间需在 1 分钟后');

  expiresUtc = expiresUtc.toISOString().replace('T', ' ').slice(0, 19);

  const created = await env.DB.prepare(
    `INSERT INTO polls (title, description, created_by, created_duty, options, hide_results, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`,
  ).bind(title, description, staff.id, staff.duty || '班委', JSON.stringify(options), hideResults, expiresUtc).first();

  await writeAudit(env.DB, {
    actorMemberId: staff.id, actorRole: staff.role, action: 'poll_create',
    targetType: 'poll', targetId: created.id, detail: { title, options: options.length, hideResults },
  });
  return json({ ok: true, id: created.id }, 201);
}

export async function vote(request, env, url, params) {
  const member = await requireMember(request, env);
  const pollId = intParam(params.id, '投票编号');
  const body = await readJson(request);
  const optionIndex = intParam(body.optionIndex, '选项', { min: 0 });

  const poll = await env.DB.prepare(
    'SELECT id, options, expires_at, hide_results FROM polls WHERE id = ?',
  ).bind(pollId).first();
  if (!poll) return fail(404, 'not_found', '投票不存在');
  if (!isOpen(poll)) return fail(403, 'poll_closed', '投票已截止');
  const options = parseOptions(poll.options);
  if (!options || optionIndex >= options.length) return fail(400, 'invalid_field', '选项不合法');

  // upsert = 改票；返回本次是否为首次投票（用于审计口径）
  const before = await env.DB.prepare(
    'SELECT option_index FROM poll_votes WHERE poll_id = ? AND member_id = ?',
  ).bind(pollId, member.id).first();

  await env.DB.prepare(
    `INSERT INTO poll_votes (poll_id, member_id, option_index) VALUES (?, ?, ?)
     ON CONFLICT(poll_id, member_id) DO UPDATE SET option_index = excluded.option_index, updated_at = datetime('now')`,
  ).bind(pollId, member.id, optionIndex).run();

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: member.role,
    action: before ? 'poll_change_vote' : 'poll_vote',
    targetType: 'poll', targetId: pollId,
    detail: { optionIndex }, // 不记录任何可关联身份的信息，仅留投票动作本身
  });

  return json({ ok: true, changed: !!before, optionIndex });
}

/** 班委提前截止投票：票数保留，仅把 expires_at 置为当前时间 */
export async function closePoll(request, env, url, params) {
  const staff = await requireStaff(request, env);
  const id = intParam(params.id, '投票编号');
  const before = await env.DB.prepare('SELECT id, title, expires_at FROM polls WHERE id = ?').bind(id).first();
  if (!before) return fail(404, 'not_found', '投票不存在');
  if (!isOpen(before)) return fail(409, 'already_closed', '投票已截止');

  await env.DB.prepare("UPDATE polls SET expires_at = datetime('now') WHERE id = ?").bind(id).run();

  await writeAudit(env.DB, {
    actorMemberId: staff.id, actorRole: staff.role, action: 'poll_close',
    targetType: 'poll', targetId: id, detail: { title: before.title },
  });
  return json({ ok: true });
}

export async function deletePoll(request, env, url, params) {
  const staff = await requireStaff(request, env);
  const id = intParam(params.id, '投票编号');
  const before = await env.DB.prepare('SELECT id, title, expires_at FROM polls WHERE id = ?').bind(id).first();
  if (!before) return fail(404, 'not_found', '投票不存在');
  await env.DB.prepare('DELETE FROM polls WHERE id = ?').bind(id).run();

  await writeAudit(env.DB, {
    actorMemberId: staff.id, actorRole: staff.role, action: 'poll_delete',
    targetType: 'poll', targetId: id, detail: { title: before.title },
  });
  return json({ ok: true });
}
