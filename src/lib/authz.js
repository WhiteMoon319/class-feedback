// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 鉴权：从 cookie 解析会话并加载成员。封禁账号一律视为未登录（401），
// 避免前端拿到半截身份后再各自判断 banned。

import { readSessionCookie, verifyToken } from './session.js';
import { ApiError } from './http.js';

const MEMBER_FIELDS = 'id, display_name, password_hash, recovery_hash, role, duty, session_version, banned';

export async function loadMember(request, env) {
  const token = readSessionCookie(request);
  if (!token) return null;
  // 先验签再查库：签名不匹配的 cookie 不产生任何数据库访问
  const payload = await verifyToken(env.SESSION_SECRET, token, /* ver */ null);
  if (!payload) return null;
  const row = await env.DB.prepare(
    `SELECT ${MEMBER_FIELDS} FROM members WHERE id = ?`,
  ).bind(payload.sub).first();
  if (!row || row.banned) return null;
  // ver 必须与库中一致（改密/重置后旧 cookie 全部失效）
  if (payload.ver !== row.session_version) return null;
  return row;
}

export async function requireMember(request, env) {
  const member = await loadMember(request, env);
  if (!member) throw new ApiError(401, 'unauthorized', '请先登录');
  return member;
}

/** 班委或维护者：维护者拥有班委的全部权限 */
export async function requireStaff(request, env) {
  const member = await requireMember(request, env);
  if (member.role !== 'committee' && member.role !== 'owner') {
    throw new ApiError(403, 'forbidden', '仅班委可操作');
  }
  return member;
}

/** 站点维护者：唯一可查看全量审计日志、生成班委码/维护者码、执行封禁的身份 */
export async function requireOwner(request, env) {
  const member = await requireMember(request, env);
  if (member.role !== 'owner') throw new ApiError(403, 'forbidden', '仅站点维护者可操作');
  return member;
}

// 授权矩阵（所有管理端接口的权限口径）：
//   操作                      班委       维护者
//   学生码生成                  ✓          ✓
//   班委码/维护者码生成          ✗          ✓
//   公告/班费/决议管理           ✓          ✓
//   举报处理（隐藏/驳回）        ✓          ✓
//   举报处理（封禁）/ setBan    ✗          ✓
//   反馈隐藏                    ✓          ✓
//   审计日志                   本人       全量
//   哈希链校验                 ✗          ✓
export const requireCommittee = requireStaff;

/** 对外暴露的成员视图：绝不包含 password_hash / recovery_hash */
export function memberView(member) {
  return {
    displayName: member.display_name,
    role: member.role,
    duty: member.duty || null,
  };
}
