// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 密码学原语：全部基于 Workers 内置 WebCrypto，无第三方依赖。
// 口令哈希格式沿用博客（D:\program\blog）的实现，便于互相校验与迁移：
//   v=1,alg=pbkdf2-sha512,iter=100000,salt=<base64url>,hash=<base64url>

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const HASH_LENGTH = 64; // SHA-512 输出字节数

export function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** 高熵随机串（邀请码、恢复码用），字符集去掉易混淆的 0/O/1/I */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomCode(length) {
  const b = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return out;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))));
}

/** 定长时间比较，避免签名/口令校验被时序攻击利用 */
export function constantTimeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

export async function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  return `v=1,alg=pbkdf2-sha512,iter=${PBKDF2_ITERATIONS},salt=${b64url(salt)},hash=${b64url(hash)}`;
}

export async function verifyPassword(password, formatted) {
  const parsed = parseHash(formatted);
  if (!parsed) return false;
  const hash = await deriveKey(password, parsed.salt, parsed.iterations);
  return constantTimeEqual(b64url(hash), b64url(parsed.hash));
}

async function deriveKey(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-512' }, key, HASH_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

function parseHash(formatted) {
  const parts = String(formatted).split(',');
  if (parts.length !== 5) return null;
  if (parts[0] !== 'v=1' || parts[1] !== 'alg=pbkdf2-sha512') return null;
  const iter = /^iter=(\d+)$/.exec(parts[2]);
  const salt = /^salt=(.+)$/.exec(parts[3]);
  const hash = /^hash=(.+)$/.exec(parts[4]);
  if (!iter || !salt || !hash) return null;
  const iterations = parseInt(iter[1], 10);
  // 迭代数上限防御：DB 被篡改时可构造超大迭代数造成 CPU DoS
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > 1_000_000) return null;
  return { iterations, salt: fromB64url(salt[1]), hash: fromB64url(hash[1]) };
}

export { decoder as textDecoder, encoder as textEncoder };
