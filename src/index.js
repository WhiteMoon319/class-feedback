// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Worker 入口。/api/* 由本 Worker 处理，其余请求回落到静态资产。
// scheduled 由 cron 触发（见 wrangler.jsonc 的 triggers）。

import { matchRoute } from './router.js';
import { toResponse, fail } from './lib/http.js';
import { runMaintenance } from './cron.js';

const API_PREFIX = '/api/';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith(API_PREFIX)) {
      return env.ASSETS.fetch(request);
    }

    // 所有写操作统一拒绝跨站 Origin（SameSite=Strict 已挡住 cookie，这里再挡一层）
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) {
        return fail(403, 'cross_origin', '跨站请求被拒绝');
      }
    }

    const matched = matchRoute(request.method, url.pathname);
    if (!matched) return fail(404, 'not_found', '接口不存在');
    if (matched.methodNotAllowed) return fail(405, 'method_not_allowed', '方法不被允许');

    try {
      return await matched.handler(request, env, url, matched.params);
    } catch (err) {
      return toResponse(err);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runMaintenance(env.DB)
        .then((r) => console.log(`[scheduled] 作废邀请码 ${r.invitesVoided}，清理限流行 ${r.rateRowsCleaned}`))
        .catch((err) => console.error('[scheduled] 维护任务失败，等待下一轮重试', err)),
    );
  },
};
