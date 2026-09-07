// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 首次部署引导：向**远程** D1 插入一个站点维护者邀请码。
// 平台本身没有「注册入口之外的账号」——第一个 owner 账号必须由此创建，
// 之后的班委码由维护者登录管理端生成。
//
// 用法：
//   npx wrangler login        # 先登录 Cloudflare
//   node scripts/bootstrap-owner.mjs
//
// 生成的邀请码 7 天内有效，注册后立即失效（一人一号）。

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(n) {
  const b = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[b[i] % ALPHABET.length];
  return out;
}

const inviteCode = `${code(4)}-${code(4)}-${code(4)}`;

const cmd =
  `npx wrangler d1 execute class-feedback-db --remote --command ` +
  `"INSERT OR IGNORE INTO invites (code, type, duty, expires_at) VALUES ('${inviteCode}','owner',NULL,datetime('now','+7 days'))"`;

console.log('[bootstrap] 向远程 D1 写入 owner 邀请码…');
execSync(cmd, { stdio: 'inherit' });
console.log('');
console.log('==============================================');
console.log(`  站点维护者邀请码（7 天内有效，一人一号）：`);
console.log('');
console.log(`  ${inviteCode}`);
console.log('');
console.log('  用它在 class.whitemoon319.xyz/register 注册，');
console.log('  该账号即站点维护者，可生成班委码与学生码。');
console.log('==============================================');
