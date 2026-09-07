// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HTTP 层小工具：统一响应格式、请求体解析与输入约束。
// 所有对外错误只返回中文 message 与稳定的 code，不回显内部细节。

const MAX_JSON_BYTES = 64 * 1024;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function fail(status, code, message) {
  return json({ ok: false, code, message }, status);
}

export async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_JSON_BYTES) throw new ApiError(413, 'too_large', '请求体过大');
  let text;
  try {
    text = await request.text();
  } catch {
    throw new ApiError(400, 'bad_request', '无法读取请求体');
  }
  if (text.length > MAX_JSON_BYTES) throw new ApiError(413, 'too_large', '请求体过大');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'bad_request', '请求体必须是 JSON 对象');
    }
    return parsed;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, 'bad_request', 'JSON 解析失败');
  }
}

/** 取字符串字段并做长度与空白约束；不合规直接抛 400 */
export function strField(body, name, { min = 1, max = 2000, required = true } = {}) {
  const raw = body?.[name];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new ApiError(400, 'invalid_field', `缺少字段：${name}`);
    return '';
  }
  if (typeof raw !== 'string') throw new ApiError(400, 'invalid_field', `字段类型错误：${name}`);
  // 折叠多余空白但保留换行（反馈正文需要多行）
  const value = raw.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (value.length < min) throw new ApiError(400, 'invalid_field', `${name} 至少 ${min} 个字符`);
  if (value.length > max) throw new ApiError(400, 'invalid_field', `${name} 最多 ${max} 个字符`);
  return value;
}

export function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new ApiError(400, 'invalid_field', `${name} 只能是 ${allowed.join(' / ')}`);
  }
  return value;
}

export function intParam(raw, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, 'invalid_field', `${name} 不是合法编号`);
  }
  return n;
}

/** 统一异常出口：ApiError 用其状态码，其余记日志并返回 500 */
export function toResponse(err) {
  if (err instanceof ApiError) return fail(err.status, err.code, err.message);
  console.error('[api] 未预期异常:', err);
  return fail(500, 'internal', '服务器内部错误');
}
