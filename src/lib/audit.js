// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 审计日志写入器：只追加 + 哈希链。
//
// 链式定义：hash(n) = SHA-256( hash(n-1) + '\n' + payload(n) )，
// payload = JSON([ts, actor_member_id, actor_role, action, target_type, target_id, detail])。
// 改写或删除任意历史行都会使后续 prev_hash 对不上，verifyChain 可检出。
//
// 并发写入用 audit_head 单例行做 CAS：UPDATE 仅在 hash 仍等于读到的旧值时成功，
// 随后 INSERT ... SELECT WHERE head = 新哈希 —— CAS 失败则整批不落入任何行，
// 由调用方重试。两条语句在同一 batch（单事务）内执行，不留半成品状态。

import { sha256Hex } from './crypto.js';

const GENESIS = 'GENESIS';
const MAX_RETRY = 5;

function chainPayload(row) {
  return JSON.stringify([
    row.ts, row.actor_member_id ?? null, row.actor_role, row.action,
    row.target_type ?? null, row.target_id ?? null, row.detail ?? null,
  ]);
}

/**
 * 追加一条审计日志。
 * detail 只允许放业务标识（反馈 id、职务名等），严禁写入 IP、原始身份。
 */
export async function writeAudit(db, entry) {
  const row = {
    ts: new Date().toISOString().replace('T', ' ').slice(0, 19),
    actor_member_id: entry.actorMemberId ?? null,
    actor_role: entry.actorRole ?? 'system',
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId == null ? null : String(entry.targetId),
    detail: entry.detail == null ? null : JSON.stringify(entry.detail),
  };

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const head = await db.prepare('SELECT hash FROM audit_head WHERE id = 1').first();
    const prevHash = head?.hash ?? GENESIS;
    const hash = await sha256Hex(`${prevHash}\n${chainPayload(row)}`);

    const results = await db.batch([
      db.prepare('UPDATE audit_head SET hash = ? WHERE id = 1 AND hash = ?').bind(hash, prevHash),
      db.prepare(
        `INSERT INTO audit_logs (ts, actor_member_id, actor_role, action, target_type, target_id, detail, prev_hash, hash)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT hash FROM audit_head WHERE id = 1) = ?`,
      ).bind(
        row.ts, row.actor_member_id, row.actor_role, row.action,
        row.target_type, row.target_id, row.detail, prevHash, hash, hash,
      ),
    ]);

    if (results[1].meta.changes === 1) return;
  }
  // 连续冲突只可能来自异常并发；宁可让请求失败，也不写入断链记录
  throw new Error('audit chain busy');
}

/**
 * 校验整条链：逐行重算哈希、比对 prev_hash，最后确认链头等于末行哈希。
 * @returns {{ok: true} | {ok: false, brokenAtId: number|null, reason: string}}
 */
export async function verifyChain(db) {
  const rows = await db.prepare(
    'SELECT id, ts, actor_member_id, actor_role, action, target_type, target_id, detail, prev_hash, hash FROM audit_logs ORDER BY id ASC',
  ).all();
  const head = await db.prepare('SELECT hash FROM audit_head WHERE id = 1').first();
  const list = rows.results ?? [];

  let expectedPrev = GENESIS;
  for (const row of list) {
    if (row.prev_hash !== expectedPrev) {
      return { ok: false, brokenAtId: row.id, reason: 'prev_hash 与上一行不连续（历史被改写或删除）' };
    }
    const recomputed = await sha256Hex(`${row.prev_hash}\n${chainPayload(row)}`);
    if (recomputed !== row.hash) {
      return { ok: false, brokenAtId: row.id, reason: '行内容与哈希不符（字段被篡改）' };
    }
    expectedPrev = row.hash;
  }

  const headHash = head?.hash ?? GENESIS;
  if (headHash !== expectedPrev) {
    return { ok: false, brokenAtId: list.length ? list[list.length - 1].id : null, reason: '链头与末行哈希不符（存在未落盘的写入）' };
  }
  return { ok: true, count: list.length };
}
