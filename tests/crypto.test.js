// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, randomCode, sha256Hex, b64url, fromB64url, constantTimeEqual,
} from '../src/lib/crypto.js';

test('口令哈希可往返校验，错误口令被拒', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.ok(hash.startsWith('v=1,alg=pbkdf2-sha512,iter=100000,salt='));
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('Correct horse battery', hash), false);
});

test('同一口令两次哈希不同（盐随机）', async () => {
  const a = await hashPassword('p@ssw0rd-123');
  const b = await hashPassword('p@ssw0rd-123');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('p@ssw0rd-123', a), true);
  assert.equal(await verifyPassword('p@ssw0rd-123', b), true);
});

test('被篡改的哈希串不会通过校验', async () => {
  const hash = await hashPassword('secret-pass');
  const tampered = hash.replace(/hash=(.+)$/, (m, g) => `hash=${g.slice(0, -4)}AAAA`);
  assert.equal(await verifyPassword('secret-pass', tampered), false);
});

test('畸形哈希与超大迭代数被拒绝（防 CPU DoS）', async () => {
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', 'v=2,alg=pbkdf2-sha512,iter=10,salt=AA,hash=AA'), false);
  assert.equal(await verifyPassword('x', 'v=1,alg=pbkdf2-sha512,iter=99999999,salt=AA,hash=AA'), false);
});

test('邀请码字符集不含易混淆的 0/O/1/I', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(randomCode(12), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
  }
});

test('base64url 往返一致', () => {
  const bytes = new Uint8Array([0, 255, 128, 64, 1, 2, 3]);
  assert.deepEqual(fromB64url(b64url(bytes)), bytes);
});

test('sha256Hex 命中已知向量', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('constantTimeEqual 正确处理长度不等', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
});
