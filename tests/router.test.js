// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchRoute } from '../src/router.js';

test('精确路径命中', () => {
  assert.ok(matchRoute('POST', '/api/auth/register'));
  assert.ok(matchRoute('GET', '/api/feedbacks'));
  assert.ok(matchRoute('GET', '/api/health'));
});

test('路径参数被捕获并解码', () => {
  const m = matchRoute('POST', '/api/feedbacks/42/replies');
  assert.ok(m);
  assert.equal(m.params.id, '42');

  const v = matchRoute('POST', '/api/admin/invites/ABCD-EFGH-JKLM/void');
  assert.equal(v.params.code, 'ABCD-EFGH-JKLM');

  const enc = matchRoute('POST', '/api/admin/invites/' + encodeURIComponent('XX-中文-0001') + '/void');
  assert.equal(enc.params.code, 'XX-中文-0001');
});

test('未登记路径返回 null', () => {
  assert.equal(matchRoute('GET', '/api/nope'), null);
  assert.equal(matchRoute('GET', '/api/feedbacks/1/nope'), null);
  assert.equal(matchRoute('GET', '/'), null);
});

test('路径存在但方法不符标记 405', () => {
  assert.deepEqual(matchRoute('DELETE', '/api/feedbacks'), { methodNotAllowed: true });
  assert.deepEqual(matchRoute('GET', '/api/auth/login'), { methodNotAllowed: true });
});

test('路由表无重复登记', () => {
  const seen = new Set();
  for (const [method, path] of ROUTE_KEYS()) {
    const key = `${method} ${path}`;
    assert.equal(seen.has(key), false, `重复登记：${key}`);
    seen.add(key);
  }
});

// router.js 未导出路由表，这里从源码提取登记项做重复检查
function ROUTE_KEYS() {
  const src = readFileSync(new URL('../src/router.js', import.meta.url), 'utf8');
  return [...src.matchAll(/\['(GET|POST)',\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
}
