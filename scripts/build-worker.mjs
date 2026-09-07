// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 用 esbuild 把 src/index.js 打包为 dist/worker.mjs（单入口，无框架）。
// 静态资源不经此步骤：wrangler 直接发布 public/。
import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: 'dist/worker.mjs',
  logLevel: 'info',
});

console.log('[build-worker] dist/worker.mjs 已生成');
