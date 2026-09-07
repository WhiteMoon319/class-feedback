// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 会话：HMAC 签名的自包含 token 放在 HttpOnly cookie 里。
// sameSite=Strict —— 平台同域部署，跨站请求根本带不上 cookie，因此无需再做 CSRF token。
// token 内嵌 ver（session_version）：改密或重置密码时 +1，旧 cookie 立即全体失效。

import { b64url, fromB64url, hmacSha256, constantTimeEqual, textEncoder, textDecoder } from './crypto.js';

const COOKIE_NAME = 'cf_class_session';
const TTL_SECONDS = 60 * 60 * 24 * 7;

export async function signToken(secret, memberId, sessionVersion) {
  const payload = b64url(textEncoder.encode(JSON.stringify({
    sub: memberId, ver: sessionVersion, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  })));
  const sig = await hmacSha256(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyToken(secret, token, sessionVersion = null) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = await hmacSha256(secret, payload);
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(textDecoder.decode(fromB64url(payload)));
    if (typeof parsed.sub !== 'number') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof parsed.ver !== 'number') return null;
    // sessionVersion 传 null 表示只验签与有效期，版本比对交给调用方对照数据库
    if (sessionVersion !== null && parsed.ver !== sessionVersion) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cookieHeaders(value, maxAge) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  return parts.join('; ');
}

export function setSessionCookie(response, token) {
  response.headers.append('Set-Cookie', cookieHeaders(token, TTL_SECONDS));
  return response;
}

export function clearSessionCookie(response) {
  response.headers.append('Set-Cookie', cookieHeaders('', 0));
  return response;
}

export function readSessionCookie(request) {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  return null;
}

export { COOKIE_NAME, TTL_SECONDS };
