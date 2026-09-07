// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 从 wrangler.jsonc.template 生成本地 wrangler.jsonc（已被 .gitignore 忽略）。
// 真实资源 ID 只允许来自环境变量或根目录 .env，不入库。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REQUIRED_KEYS = ['CLASSFEEDBACK_D1_ID'];
const TEMPLATE_FILE = 'wrangler.jsonc.template';
const OUTPUT_FILE = 'wrangler.jsonc';

function loadDotEnv() {
  if (!existsSync('.env')) return {};
  const out = {};
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

const values = { ...loadDotEnv() };
for (const key of REQUIRED_KEYS) {
  if (process.env[key] !== undefined && process.env[key] !== '') {
    values[key] = process.env[key];
  }
}

const template = readFileSync(TEMPLATE_FILE, 'utf8');
const missing = REQUIRED_KEYS.filter((key) => !values[key]);

let output = template;
for (const key of REQUIRED_KEYS) {
  if (values[key]) {
    output = output.split(`\${${key}}`).join(values[key]);
  }
}
writeFileSync(OUTPUT_FILE, output);

if (missing.length > 0) {
  console.warn(
    `[cf-config] 警告：缺少环境变量 ${missing.join(', ')}，${OUTPUT_FILE} 中保留了 ${missing
      .map((k) => `\${${k}}`)
      .join(' ')} 占位符。`,
  );
  console.warn('[cf-config] 请复制 .env.example 为根目录 .env 并填写真实资源 ID，再运行 npm run cf:config。');
} else {
  console.log(`[cf-config] ${OUTPUT_FILE} 已由模板生成（真实资源 ID 仅存于本机，不入库）。`);
}
