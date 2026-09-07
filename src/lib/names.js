// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 假名生成：根假名与反馈笔名共用同一词库，格式「形容词的名词」。
// 刻意避开序号与编号，防止「第 N 个注册」这类顺序信息泄露。

const ADJECTIVES = [
  '安静', '明亮', '遥远', '温和', '慵懒', '坚定', '好奇', '从容', '清爽', '沉默',
  '自由', '轻盈', '沉稳', '热忱', '淡然', '敏锐', '松弛', '认真', '坦率', '含蓄',
  '缓慢', '透明', '素净', '闲散', '倔强', '温柔', '冷静', '羞涩', '莽撞', '审慎',
];

const NOUNS = [
  '橘子', '雨伞', '书签', '台灯', '地铁', '白板', '粉笔', '盆栽', '风筝', '灯塔',
  '帆船', '麦穗', '银杏', '刺猬', '水獭', '麻雀', '灰鲸', '小鹿', '野猫', '狐狸',
  '石头', '云朵', '晚风', '晨露', '咖啡', '面包', '西瓜', '板栗', '抽屉', '水杯',
  '走廊', '操场', '长椅', '单车', '耳机', '便签', '玻璃', '路标', '站牌', '绿萝',
];

const BASE_SPACE = ADJECTIVES.length * NOUNS.length; // 1200

function pick(arr) {
  return arr[crypto.getRandomValues(new Uint32Array(1))[0] % arr.length];
}

/** 一个随机候选名；词库耗尽时追加数字后缀扩出 120000 空间 */
export function candidateName() {
  const base = `${pick(ADJECTIVES)}的${pick(NOUNS)}`;
  return Math.random() < 0.5 ? base : `${base}${1 + Math.floor(Math.random() * 99)}`;
}

/**
 * 生成一个在 used 集合中不存在的名字。
 * @param {(name:string)=>boolean} isTaken 占用判定（查库或查内存集合）
 */
export async function generateName(isTaken, maxTries = 50) {
  for (let i = 0; i < maxTries; i++) {
    const name = candidateName();
    if (!(await isTaken(name))) return name;
  }
  // 兜底：词库接近饱和时直接加长数字后缀，空间足够班级规模用
  for (let n = 100; n < 10000; n++) {
    const name = candidateName().replace(/\d+$/, '') + n;
    if (!(await isTaken(name))) return name;
  }
  throw new Error('假名空间耗尽');
}

export { BASE_SPACE };
