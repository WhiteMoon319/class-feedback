// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 单入口路由：一张表看清所有端点，无框架。
// 路径参数用 :name 表示，处理器签名为 (request, env, url, params)。

import * as auth from './api/auth.js';
import * as feedbacks from './api/feedbacks.js';
import * as announcements from './api/announcements.js';
import * as admin from './api/admin.js';
import * as polls from './api/polls.js';
import * as invites from './api/invites.js';
import { json } from './lib/http.js';

const ROUTES = [
  ['GET', '/api/health', () => json({ ok: true, ts: new Date().toISOString() })],

  // 邀请链接预校验（游客可读，仅返回状态与类型，不含使用者）
  ['GET', '/api/invites/:code', invites.checkInvite],

  // 注册与登录
  ['POST', '/api/auth/register', auth.register],
  ['POST', '/api/auth/login', auth.login],
  ['POST', '/api/auth/logout', auth.logout],
  ['POST', '/api/auth/reset', auth.resetPassword],
  ['POST', '/api/auth/password', auth.changePassword],
  ['GET', '/api/auth/me', auth.me],

  // 反馈工单（列表与详情对游客只读开放）
  ['GET', '/api/feedbacks', feedbacks.listFeedbacks],
  ['GET', '/api/feedbacks/:id', feedbacks.getFeedback],
  ['POST', '/api/feedbacks', feedbacks.createFeedback],
  ['GET', '/api/my/feedbacks', feedbacks.myFeedbacks],
  ['POST', '/api/feedbacks/:id/replies', feedbacks.addReply],
  ['POST', '/api/feedbacks/:id/status', feedbacks.updateStatus],
  ['POST', '/api/feedbacks/:id/report', feedbacks.reportContent],
  ['POST', '/api/feedbacks/:id/delete', feedbacks.deleteFeedback],

  // 班务公开（游客可读，班委可写）
  ['GET', '/api/announcements', announcements.listAnnouncements],
  ['GET', '/api/announcements/:id', announcements.getAnnouncement],
  ['GET', '/api/finance/summary', announcements.financeSummary],
  ['POST', '/api/announcements', announcements.createAnnouncement],
  ['POST', '/api/announcements/:id/update', announcements.updateAnnouncement],
  ['POST', '/api/announcements/:id/delete', announcements.deleteAnnouncement],
  ['POST', '/api/announcements/:id/attachments', announcements.uploadAttachment],
  ['POST', '/api/attachments/:id/delete', announcements.deleteAttachment],
  ['GET', '/api/attachments/:id', announcements.getAttachment],

  // 投票（决议的实质）
  ['GET', '/api/polls', polls.listPolls],
  ['GET', '/api/polls/:id', polls.getPoll],
  ['POST', '/api/polls', polls.createPoll],
  ['POST', '/api/polls/:id/vote', polls.vote],
  ['POST', '/api/polls/:id/close', polls.closePoll],
  ['POST', '/api/polls/:id/delete', polls.deletePoll],

  // 管理端
  ['POST', '/api/admin/invites', admin.createInvites],
  ['GET', '/api/admin/invites', admin.listInvites],
  ['POST', '/api/admin/invites/:code/void', admin.voidInvite],
  ['GET', '/api/admin/reports', admin.listReports],
  ['POST', '/api/admin/reports/:id/handle', admin.handleReport],
  ['POST', '/api/admin/members/:id/ban', admin.setBan],
  ['POST', '/api/admin/feedbacks/:id/hide', admin.hideFeedback],
  ['GET', '/api/admin/audit', admin.listAudit],
  ['GET', '/api/admin/audit/verify', admin.checkChain],
  ['GET', '/api/admin/members', admin.listMembers],
  ['GET', '/api/admin/hidden', admin.listHidden],
  ['POST', '/api/admin/replies/:id/hide', admin.hideReply],
];

const COMPILED = ROUTES.map(([method, path, handler]) => ({
  method,
  handler,
  segs: path.split('/').filter(Boolean),
}));

export function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const methodMismatch = [];

  for (const route of COMPILED) {
    if (route.segs.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segs[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) { ok = false; break; }
    }
    if (!ok) continue;
    if (route.method !== method) { methodMismatch.push(route.method); continue; }
    return { handler: route.handler, params };
  }
  if (methodMismatch.length) return { methodNotAllowed: true };
  return null;
}
