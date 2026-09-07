// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 本地开发种子：每次运行随机生成邀请码并写入**本地** D1，打印到控制台。
// 禁止任何固定邀请码进入代码库（固定码=任何人可注册=提权入口）。
// 由 npm run cf:db:local 在迁移后自动调用；冒烟测试从 .wrangler/dev-invites.json 读取。
//
// 用法：node scripts/dev-seed.mjs

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(n) {
  const b = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[b[i] % ALPHABET.length];
  return out;
}

// 生成：2 个学生码、2 个班委码、1 个维护者码
const invites = [
  { code: `${code(4)}-${code(4)}-${code(4)}`, type: 'student', duty: null },
  { code: `${code(4)}-${code(4)}-${code(4)}`, type: 'student', duty: null },
  { code: `${code(4)}-${code(4)}-${code(4)}`, type: 'committee', duty: '班长' },
  { code: `${code(4)}-${code(4)}-${code(4)}`, type: 'committee', duty: '生活委员' },
  { code: `${code(4)}-${code(4)}-${code(4)}`, type: 'owner', duty: null },
];

const values = invites
  .map((i) => `('${i.code}','${i.type}',${i.duty ? `'${i.duty}'` : 'NULL'},datetime('now','+14 days'))`)
  .join(',');

const cmd =
  `npx wrangler d1 execute class-feedback-db --local --command ` +
  `"INSERT OR IGNORE INTO invites (code, type, duty, expires_at) VALUES ${values}"`;

execSync(cmd, { stdio: 'inherit' });
writeFileSync('.wrangler/dev-invites.json', JSON.stringify(invites, null, 2));

console.log('');
console.log('==============================================');
console.log('  本地开发邀请码（14 天内有效，一人一号）：');
console.log('');
for (const i of invites) {
  console.log(`  [${i.type.padEnd(9)}] ${i.duty ? i.duty + ' ' : ''}${i.code}`);
}
console.log('');
console.log('  已同时写入 .wrangler/dev-invites.json 供冒烟测试读取。');
console.log('==============================================');
