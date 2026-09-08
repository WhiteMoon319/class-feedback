// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 班务公开：公告 / 班费收支 / 决议记录。游客可读，班委可写。
// 班费记录带凭证图片（R2），图片经 Worker 代理输出，不使用公开桶直链。

import { requireCommittee } from '../lib/authz.js';
import { json, fail, readJson, strField, intParam, oneOf, ApiError } from '../lib/http.js';
import { writeAudit } from '../lib/audit.js';
import { sha256Hex } from '../lib/crypto.js';

const CATEGORIES = ['announcement', 'finance', 'minutes'];
const CATEGORY_TEXT = { announcement: '公告', finance: '班费', minutes: '决议' };
const TITLE_MAX = 80;
const BODY_MAX = 8000;

const ATTACHMENT_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function announcementView(row, attachments = []) {
  return {
    id: row.id,
    category: row.category,
    categoryText: CATEGORY_TEXT[row.category],
    title: row.title,
    body: row.body,
    amount: row.amount || null,
    direction: row.direction || null,
    duty: row.created_duty,
    pinned: !!row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments,
  };
}

export async function listAnnouncements(request, env, url) {
  const category = url.searchParams.get('category');
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  const where = category && CATEGORIES.includes(category) ? 'category = ?' : '1 = 1';
  const binds = category && CATEGORIES.includes(category) ? [category] : [];

  const rows = await env.DB.prepare(
    `SELECT id, category, title, body, amount, direction, created_duty, pinned, created_at, updated_at
     FROM announcements WHERE ${where}
     ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all();

  const list = rows.results ?? [];
  if (list.length === 0) return json({ ok: true, items: [], limit, offset });

  const ids = list.map((r) => r.id);
  const atts = await env.DB.prepare(
    `SELECT id, announcement_id, mime, filename, size FROM attachments
     WHERE announcement_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`,
  ).bind(...ids).all();

  const grouped = new Map();
  for (const a of atts.results ?? []) {
    if (!grouped.has(a.announcement_id)) grouped.set(a.announcement_id, []);
    grouped.get(a.announcement_id).push({
      id: a.id, mime: a.mime, filename: a.filename, size: a.size,
      url: `/api/attachments/${a.id}`,
    });
  }
  return json({
    ok: true,
    items: list.map((r) => announcementView(r, grouped.get(r.id) ?? [])),
    limit,
    offset,
  });
}

export async function getAnnouncement(request, env, url, params) {
  const id = intParam(params.id, '公告编号');
  const row = await env.DB.prepare(
    'SELECT id, category, title, body, amount, direction, created_duty, pinned, created_at, updated_at FROM announcements WHERE id = ?',
  ).bind(id).first();
  if (!row) return fail(404, 'not_found', '内容不存在');
  const atts = await env.DB.prepare(
    'SELECT id, mime, filename, size FROM attachments WHERE announcement_id = ? ORDER BY id ASC',
  ).bind(id).all();
  return json({
    ok: true,
    announcement: announcementView(row, (atts.results ?? []).map((a) => ({
      id: a.id, mime: a.mime, filename: a.filename, size: a.size, url: `/api/attachments/${a.id}`,
    }))),
  });
}

function readFields(body, category) {
  const title = strField(body, 'title', { min: 2, max: TITLE_MAX });
  const text = strField(body, 'body', { min: 1, max: BODY_MAX });
  const pinned = body.pinned === true ? 1 : 0;

  let amount = null;
  let direction = null;
  if (category === 'finance') {
    amount = strField(body, 'amount', { min: 1, max: 24 });
    if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) {
      throw Object.assign(new Error('金额格式不正确'), { status: 400, code: 'invalid_field' });
    }
    direction = oneOf(body.direction, ['income', 'expense'], '收支方向');
  }
  return { title, text, pinned, amount, direction };
}

export async function createAnnouncement(request, env) {
  const member = await requireCommittee(request, env);
  const body = await readJson(request);
  const category = oneOf(body.category, CATEGORIES, '类别');
  const { title, text, pinned, amount, direction } = readFields(body, category);

  const created = await env.DB.prepare(
    `INSERT INTO announcements (category, title, body, amount, direction, created_by, created_duty, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`,
  ).bind(category, title, text, amount, direction, member.id, member.duty || '班委', pinned).first();

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: 'committee', action: 'announcement_create',
    targetType: 'announcement', targetId: created.id, detail: { category, title },
  });
  return json({ ok: true, id: created.id }, 201);
}

export async function updateAnnouncement(request, env, url, params) {
  const member = await requireCommittee(request, env);
  const id = intParam(params.id, '公告编号');
  const body = await readJson(request);

  const before = await env.DB.prepare(
    'SELECT id, category, title, body, amount, direction, pinned FROM announcements WHERE id = ?',
  ).bind(id).first();
  if (!before) return fail(404, 'not_found', '内容不存在');

  // 部分更新：只取请求提供的字段，未提供则保留原值
  const category = body.category !== undefined ? oneOf(body.category, CATEGORIES, '类别') : before.category;
  const title = body.title !== undefined ? strField(body, 'title', { min: 2, max: TITLE_MAX }) : before.title;
  const text = body.body !== undefined ? strField(body, 'body', { min: 1, max: BODY_MAX }) : before.body;
  const pinned = body.pinned !== undefined ? (body.pinned === true ? 1 : 0) : before.pinned;

  let amount = before.amount;
  let direction = before.direction;
  if (category === 'finance') {
    if (body.amount !== undefined) {
      amount = strField(body, 'amount', { min: 1, max: 24 });
      if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) {
        throw new ApiError(400, 'invalid_field', '金额格式不正确');
      }
      direction = body.direction !== undefined
        ? oneOf(body.direction, ['income', 'expense'], '收支方向')
        : (before.direction || (amount.startsWith('-') ? 'expense' : 'income'));
    }
  } else {
    amount = null;
    direction = null;
  }

  await env.DB.prepare(
    `UPDATE announcements SET category = ?, title = ?, body = ?, amount = ?, direction = ?, pinned = ?,
     updated_at = datetime('now') WHERE id = ?`,
  ).bind(category, title, text, amount, direction, pinned, id).run();

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: 'committee', action: 'announcement_update',
    targetType: 'announcement', targetId: id, detail: { category, title },
  });
  return json({ ok: true });
}

export async function deleteAnnouncement(request, env, url, params) {
  const member = await requireCommittee(request, env);
  const id = intParam(params.id, '公告编号');
  const before = await env.DB.prepare('SELECT id, title, category FROM announcements WHERE id = ?').bind(id).first();
  if (!before) return fail(404, 'not_found', '内容不存在');

  // 先删 DB 行（附件行由外键级联删除）再删 R2 对象：
  // DB 失败时图片仍在可重试；反序会留下悬空引用
  const atts = await env.DB.prepare('SELECT r2_key FROM attachments WHERE announcement_id = ?').bind(id).all();
  await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(id).run();
  for (const a of atts.results ?? []) {
    try { await env.MEDIA.delete(a.r2_key); } catch (e) { console.error('[announce] R2 删除失败（孤儿对象）', a.r2_key, e); }
  }

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: 'committee', action: 'announcement_delete',
    targetType: 'announcement', targetId: id, detail: { category: before.category, title: before.title },
  });
  return json({ ok: true });
}

/** 班委上传凭证图片：mime 白名单 + 大小上限，key 用内容哈希去重 */
export async function uploadAttachment(request, env, url, params) {
  const member = await requireCommittee(request, env);
  const id = intParam(params.id, '公告编号');
  const exists = await env.DB.prepare('SELECT id FROM announcements WHERE id = ?').bind(id).first();
  if (!exists) return fail(404, 'not_found', '内容不存在');

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return fail(400, 'no_file', '未收到文件');

  const maxBytes = Number(env.ATTACHMENT_MAX_BYTES) || DEFAULT_MAX_BYTES;
  if (file.size > maxBytes) return fail(413, 'too_large', `图片不能超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`);

  const mime = (file.type || '').toLowerCase();
  const ext = ATTACHMENT_MIME[mime];
  if (!ext) return fail(415, 'unsupported_media', '仅支持 JPG / PNG / WebP 图片');

  const bytes = await file.arrayBuffer();
  const digest = await sha256Hex(String.fromCharCode(...new Uint8Array(bytes)));
  const r2Key = `announcements/${id}/${digest.slice(0, 32)}.${ext}`;

  await env.MEDIA.put(r2Key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
  });

  const created = await env.DB.prepare(
    'INSERT OR REPLACE INTO attachments (announcement_id, r2_key, mime, filename, size) VALUES (?, ?, ?, ?, ?) RETURNING id',
  ).bind(id, r2Key, mime, (file.name || 'image').slice(0, 120), bytes.byteLength).first();

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: 'committee', action: 'attachment_upload',
    targetType: 'attachment', targetId: created.id, detail: { announcementId: id, mime, size: bytes.byteLength },
  });
  return json({ ok: true, id: created.id, url: `/api/attachments/${created.id}` }, 201);
}

/** 附件读取：游客可访问（班务凭证本就公开），但不暴露桶直链 */
export async function getAttachment(request, env, url, params) {
  const id = intParam(params.id, '附件编号');
  const row = await env.DB.prepare(
    'SELECT r2_key, mime, filename FROM attachments WHERE id = ?',
  ).bind(id).first();
  if (!row) return fail(404, 'not_found', '附件不存在');
  const object = await env.MEDIA.get(row.r2_key);
  if (!object) return fail(404, 'not_found', '附件已丢失');

  return new Response(object.body, {
    headers: {
      'content-type': row.mime,
      'cache-control': 'public, max-age=86400',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    },
  });
}

/** 班委删除单个附件（DB 行 + R2 对象），用于传错图时精确移除 */
export async function deleteAttachment(request, env, url, params) {
  const member = await requireCommittee(request, env);
  const id = intParam(params.id, '附件编号');
  const row = await env.DB.prepare(
    'SELECT id, announcement_id, r2_key FROM attachments WHERE id = ?',
  ).bind(id).first();
  if (!row) return fail(404, 'not_found', '附件不存在');

  // 先删 DB 行再删 R2 对象：DB 失败时图片仍在（可重试）；
  // 反序则在 DB 失败后留下悬空引用（用户看到附件但取不到图）
  await env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(id).run();
  try { await env.MEDIA.delete(row.r2_key); } catch (e) { console.error('[announce] R2 删除失败（孤儿对象，无引用）', row.r2_key, e); }

  await writeAudit(env.DB, {
    actorMemberId: member.id, actorRole: 'committee', action: 'attachment_delete',
    targetType: 'attachment', targetId: id, detail: { announcementId: row.announcement_id },
  });
  return json({ ok: true });
}

export { CATEGORY_TEXT, CATEGORIES };

/** 班费收支汇总（游客可读）：总收入 / 总支出 / 结余 / 笔数 */
export async function financeSummary(request, env) {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'income' THEN CAST(REPLACE(amount, ',', '') AS REAL) ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN direction = 'expense' THEN ABS(CAST(REPLACE(amount, ',', '') AS REAL)) ELSE 0 END), 0) AS expense,
       COUNT(*) AS count
     FROM announcements WHERE category = 'finance' AND amount IS NOT NULL`,
  ).first();
  const income = Number(row?.income ?? 0);
  const expense = Number(row?.expense ?? 0);
  return json({
    ok: true,
    income: Math.round(income * 100) / 100,
    expense: Math.round(expense * 100) / 100,
    balance: Math.round((income - expense) * 100) / 100,
    count: row?.count ?? 0,
  });
}
