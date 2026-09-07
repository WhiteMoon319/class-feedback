// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateName, candidateName } from '../src/lib/names.js';

test('候选名符合「形容词的名词」格式', () => {
  for (let i = 0; i < 50; i++) {
    assert.match(candidateName(), /^[\u4e00-\u9fa5]{2,3}的[\u4e00-\u9fa5]{2,3}\d{0,2}$/);
  }
});

test('生成器跳过已占用名字', async () => {
  const taken = new Set();
  for (let i = 0; i < 30; i++) {
    const name = await generateName((n) => taken.has(n));
    assert.equal(taken.has(name), false, `不应重复分配 ${name}`);
    taken.add(name);
  }
  assert.equal(taken.size, 30);
});

test('词库接近饱和时仍能靠数字后缀扩出空间', async () => {
  // 占用全部 1200 个基础组合，迫使生成器走带后缀分支
  const taken = new Set();
  for (let i = 0; i < 4000; i++) taken.add(await generateName((n) => taken.has(n)));
  assert.equal(taken.size, 4000);
});
