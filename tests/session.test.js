// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, readSessionCookie, setSessionCookie, clearSessionCookie, COOKIE_NAME } from '../src/lib/session.js';

const SECRET = 'unit-test-secret';

test('签发的 token 可验签并取回成员编号', async () => {
  const token = await signToken(SECRET, 7, 1);
  const parsed = await verifyToken(SECRET, token, 1);
  assert.equal(parsed.sub, 7);
  assert.equal(parsed.ver, 1);
});

test('签名被篡改的 token 拒绝', async () => {
  const token = await signToken(SECRET, 7, 1);
  const [payload] = token.split('.');
  assert.equal(await verifyToken(SECRET, `${payload}.${'x'.repeat(20)}`, 1), null);
  assert.equal(await verifyToken('other-secret', token, 1), null);
});

test('会话版本不匹配即失效（改密后旧 cookie 全体作废）', async () => {
  const token = await signToken(SECRET, 7, 3);
  assert.equal(await verifyToken(SECRET, token, 4), null);
  assert.ok(await verifyToken(SECRET, token, 3));
});

test('传 null 表示只验签不比对版本', async () => {
  const token = await signToken(SECRET, 7, 9);
  const parsed = await verifyToken(SECRET, token, null);
  assert.equal(parsed.sub, 7);
  assert.equal(parsed.ver, 9);
});

test('畸形 token 不抛异常', async () => {
  for (const bad of ['', 'a', 'a.b', 'xxx.yyy', `${Buffer.from('{}').toString('base64url')}.zz`]) {
    assert.equal(await verifyToken(SECRET, bad, 1), null);
  }
});

test('cookie 属性满足 HttpOnly + SameSite=Strict', async () => {
  const res = setSessionCookie(new Response('ok'), await signToken(SECRET, 1, 1));
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie.includes(`${COOKIE_NAME}=`));
  assert.ok(setCookie.includes('HttpOnly'));
  assert.ok(setCookie.includes('SameSite=Strict'));
  assert.ok(/Max-Age=\d+/.test(setCookie));

  const cleared = clearSessionCookie(new Response('ok'));
  assert.match(cleared.headers.get('set-cookie'), /Max-Age=0/);
});

test('从请求头解析会话 cookie', async () => {
  const token = await signToken(SECRET, 3, 2);
  const req = new Request('https://example.com/api/auth/me', {
    headers: { cookie: `other=1; ${COOKIE_NAME}=${token}; third=2` },
  });
  assert.equal(readSessionCookie(req), token);
  assert.equal(readSessionCookie(new Request('https://example.com/')), null);
});
