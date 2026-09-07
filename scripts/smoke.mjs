// 班务平台 class-feedback · Copyright (C) 2026 WhiteMoon319
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 端到端冒烟：对着本地 wrangler dev 跑完整业务链路，并断言匿名不变量。
// 用法：先 npm run cf:db:local 重置，再 npm run cf:dev，然后 node scripts/smoke.mjs
//
// 与 npm test 分开，因为它需要一个运行中的 Worker；CI 里可单独作为 e2e 阶段。

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8787';
const COOKIE_NAME = 'cf_class_session';

// 开发种子码由 cf:db:local → scripts/dev-seed.mjs 随机生成并写入 .wrangler/dev-invites.json
import { readFileSync } from 'node:fs';
const devInvites = JSON.parse(readFileSync(new URL('../.wrangler/dev-invites.json', import.meta.url), 'utf8'));
const students = devInvites.filter((i) => i.type === 'student');
const committees = devInvites.filter((i) => i.type === 'committee');
const SEED = {
  owner: devInvites.find((i) => i.type === 'owner')?.code,
  stu1: students[0]?.code,
  stu2: students[1]?.code,
  comm: committees.find((i) => i.duty === '生活委员')?.code ?? committees[0]?.code,
};

let passed = 0;
let failed = 0;
let jar = new Map();

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  \u2714 ${name}`); }
  else { failed++; console.log(`  \u2718 ${name} ${extra}`); }
}

function step(name) { console.log(`\n[${name}]`); }

async function call(method, path, body) {
  const headers = { origin: new URL(BASE).origin };
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) headers.cookie = cookie;

  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const [pair] = setCookie.split(';');
    const idx = pair.indexOf('=');
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (value) jar.set(name, value); else jar.delete(name);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如图片） */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** 切换身份：清空 cookie 罐后重新登录，避免脚本自身把身份串味 */
async function signIn(name, password) {
  jar = new Map();
  const r = await call('POST', '/api/auth/login', { name, password });
  if (r.status !== 200) throw new Error(`登录失败（${name}）：${r.status} ${r.text}`);
  return r;
}

/** 以游客身份调用：不带任何 cookie */
async function guest(method, path) {
  const saved = jar;
  jar = new Map();
  const r = await call(method, path);
  jar = saved;
  return r;
}

// 1x1 透明 PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  console.log(`\n=== 班务平台冒烟 @ ${BASE} ===`);

  const health = await guest('GET', '/api/health');
  ok('健康检查', health.status === 200 && health.json?.ok);

  // ---------- 注册 ----------
  step('注册与双层假名');
  const identities = {};
  async function register(label, invite, password) {
    jar = new Map();
    const r = await call('POST', '/api/auth/register', { inviteCode: invite, password });
    identities[label] = {
      root: r.json?.member?.displayName,
      recovery: r.json?.recoveryCode,
      password,
      role: r.json?.member?.role,
      duty: r.json?.member?.duty,
      status: r.status,
    };
    return r;
  }

  const owner = await register('owner', SEED.owner, 'owner-pass-123');
  ok('维护者注册', owner.status === 201 && identities.owner.role === 'owner', JSON.stringify(owner.json));
  ok('返回根假名与恢复码', !!identities.owner.root && !!identities.owner.recovery);

  const stu1 = await register('stu1', SEED.stu1, 'student-pass-1');
  ok('学生注册', stu1.status === 201 && identities.stu1.role === 'student', JSON.stringify(stu1.json));
  const stu2 = await register('stu2', SEED.stu2, 'student-pass-2');
  ok('第二名学生注册', stu2.status === 201);
  const comm = await register('comm', SEED.comm, 'committee-pass');
  ok('班委注册带职务', comm.status === 201 && identities.comm.duty === '生活委员', JSON.stringify(comm.json));

  jar = new Map();
  const reuse = await call('POST', '/api/auth/register', { inviteCode: SEED.stu2, password: 'another-pass' });
  ok('邀请码不可重复使用', reuse.status === 400 && reuse.json?.code === 'bad_invite');

  const allRoots = Object.values(identities).map((i) => i.root).filter(Boolean);

  // ---------- 管理端邀请码 ----------
  step('邀请码管理');
  // 越权护栏：班委可发学生码，但班委码/维护者码仅 owner 可发
  await signIn(identities.comm.root, identities.comm.password);
  const stuByComm = await call('POST', '/api/admin/invites', { type: 'student', count: 1 });
  ok('班委可生成学生码', stuByComm.status === 201, JSON.stringify(stuByComm.json));
  const commByComm = await call('POST', '/api/admin/invites', { type: 'committee', count: 1 });
  ok('班委生成班委码被拒', commByComm.status === 403, JSON.stringify(commByComm.json));
  const ownerByComm = await call('POST', '/api/admin/invites', { type: 'owner', count: 1 });
  ok('班委生成 owner 码被拒', ownerByComm.status === 403, JSON.stringify(ownerByComm.json));

  await signIn(identities.owner.root, identities.owner.password);
  const invList = await call('GET', '/api/admin/invites');
  ok('邀请码列表可查', invList.status === 200 && invList.json?.items?.length >= 4, JSON.stringify(invList.json));
  const invMake = await call('POST', '/api/admin/invites', { type: 'committee', duty: '学习委员', count: 2 });
  ok('班委码生成带职务', invMake.status === 201 && invMake.json?.codes?.length === 2 && invMake.json?.duty === '学习委员',
    JSON.stringify(invMake.json));
  const invVoid = await call('POST', `/api/admin/invites/${encodeURIComponent(invMake.json.codes[0])}/void`);
  ok('邀请码作废', invVoid.status === 200, JSON.stringify(invVoid.json));
  const invVoidAgain = await call('POST', `/api/admin/invites/${encodeURIComponent(invMake.json.codes[0])}/void`);
  ok('重复作废被拒', invVoidAgain.status === 404);

  const stuInviteReg = await call('POST', '/api/auth/register', { inviteCode: invMake.json.codes[1], password: 'learner-pass-1' });
  ok('新班委码可注册为学习委员', stuInviteReg.status === 201 && stuInviteReg.json?.member?.role === 'committee'
    && stuInviteReg.json?.member?.duty === '学习委员', JSON.stringify(stuInviteReg.json));

  // ---------- 自定义昵称 ----------
  step('自定义昵称');
  await signIn(identities.owner.root, identities.owner.password);
  const nickCodes = await call('POST', '/api/admin/invites', { type: 'student', count: 3 });
  const [codeA, codeB, codeC] = nickCodes.json.codes;
  const custom1 = await call('POST', '/api/auth/register', { inviteCode: codeA, password: 'custom-pass-1', displayName: '奶茶三分糖' });
  ok('自定义昵称注册成功', custom1.status === 201 && custom1.json?.member?.displayName === '奶茶三分糖',
    JSON.stringify(custom1.json));
  const customDup = await call('POST', '/api/auth/register', { inviteCode: codeB, password: 'custom-pass-2', displayName: '奶茶三分糖' });
  ok('昵称重复被拒且不烧码', customDup.status === 409 && customDup.json?.code === 'name_taken', JSON.stringify(customDup.json));
  const customBad = await call('POST', '/api/auth/register', { inviteCode: codeC, password: 'custom-pass-3', displayName: '123456' });
  ok('纯数字昵称被拒', customBad.status === 400 && customBad.json?.code === 'invalid_field', JSON.stringify(customBad.json));

  // ---------- 反馈与笔名 ----------
  step('反馈工单流');
  await signIn(identities.stu1.root, identities.stu1.password);
  const fb1 = await call('POST', '/api/feedbacks', { title: '教室空调太吵', body: '下午第二节课基本听不清老师讲话，能不能报修一下。' });
  ok('提交反馈', fb1.status === 201 && !!fb1.json?.alias, JSON.stringify(fb1.json));
  const fb1Alias = fb1.json?.alias;

  const fb2 = await call('POST', '/api/feedbacks', { title: '班费明细希望更清楚', body: '希望每笔支出都能附上发票照片，方便大家核对。' });
  ok('同一人第二条反馈得到不同笔名', fb2.status === 201 && fb2.json?.alias !== fb1Alias, `${fb1Alias} vs ${fb2.json?.alias}`);
  ok('笔名不等于任何根假名', !allRoots.includes(fb1Alias) && !allRoots.includes(fb2.json?.alias));

  const badFb = await call('POST', '/api/feedbacks', { title: '短', body: '太短了' });
  ok('正文过短被拒', badFb.status === 400);

  const mine = await call('GET', '/api/my/feedbacks');
  ok('我的反馈按本人聚合', mine.status === 200 && mine.json?.items?.length === 2, `n=${mine.json?.items?.length}`);

  await signIn(identities.stu2.root, identities.stu2.password);
  const fb3 = await call('POST', '/api/feedbacks', { title: '体育课器材太少', body: '羽毛球拍不够用，建议增购一些。' });
  ok('stu2 提交反馈', fb3.status === 201, JSON.stringify(fb3.json));

  await signIn(identities.stu1.root, identities.stu1.password);
  await signIn(identities.comm.root, identities.comm.password);
  const rep1 = await call('POST', `/api/feedbacks/${fb1.json.id}/replies`, { body: '已联系后勤，预计本周内上门检修。' });
  ok('班委回复署职务', rep1.status === 201 && rep1.json?.reply?.displayName === '生活委员', JSON.stringify(rep1.json));

  const rep2 = await call('POST', `/api/feedbacks/${fb1.json.id}/replies`, { body: '补充：检修时间待定，会另行通知。', anonymous: true });
  ok('班委匿名回复显示「班委」', rep2.status === 201 && rep2.json?.reply?.displayName === '班委', JSON.stringify(rep2.json));

  await signIn(identities.stu1.root, identities.stu1.password);
  const rep3 = await call('POST', `/api/feedbacks/${fb1.json.id}/replies`, { body: '好的，谢谢处理。' });
  ok('学生补充沿用笔名', rep3.status === 201 && rep3.json?.reply?.displayName === fb1Alias, JSON.stringify(rep3.json));

  const crossReply = await call('POST', `/api/feedbacks/${fb3.json.id}/replies`, { body: '测试越权' });
  ok('不能回复他人反馈', crossReply.status === 403, JSON.stringify(crossReply.json));

  await signIn(identities.comm.root, identities.comm.password);
  const st = await call('POST', `/api/feedbacks/${fb1.json.id}/status`, { status: 'in_review' });
  ok('状态流转为处理中', st.status === 200 && st.json?.status === 'in_review');
  const badStatus = await call('POST', `/api/feedbacks/${fb1.json.id}/status`, { status: 'whatever' });
  ok('非法状态被拒', badStatus.status === 400);

  // ---------- 匿名不变量 ----------
  step('匿名不变量');
  const guestList = await guest('GET', '/api/feedbacks');
  ok('游客可读反馈列表', guestList.status === 200 && guestList.json?.items?.length >= 2);
  ok('列表不含 member_id', !guestList.text.includes('member_id'));
  for (const root of allRoots) ok(`列表不含根假名 ${root}`, !guestList.text.includes(root));

  const detail = await guest('GET', `/api/feedbacks/${fb1.json.id}`);
  ok('详情不含 member_id', !detail.text.includes('member_id'));
  ok('详情不含根假名', !allRoots.some((r) => detail.text.includes(r)));
  ok('详情含职务与匿名署名', detail.text.includes('生活委员') && detail.text.includes('班委'));

  // ---------- 班务公开与图片 ----------
  step('班务公开与 R2 图片');
  const ann = await call('POST', '/api/announcements', {
    category: 'finance', title: '9 月班费支出：桶装水 3 桶', body: '合计 129 元，发票见附件。',
    amount: '-129.00', direction: 'expense', pinned: true,
  });
  ok('班委发布班费记录', ann.status === 201, JSON.stringify(ann.json));

  const form = new FormData();
  form.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'receipt.png');
  const up = await call('POST', `/api/announcements/${ann.json.id}/attachments`, form);
  ok('上传发票图片', up.status === 201 && !!up.json?.url, JSON.stringify(up.json));

  const badForm = new FormData();
  badForm.append('file', new Blob([Buffer.from('MZ\x00not an image')], { type: 'application/x-msdownload' }), 'evil.exe');
  const badUp = await call('POST', `/api/announcements/${ann.json.id}/attachments`, badForm);
  ok('非白名单 mime 被拒', badUp.status === 415, JSON.stringify(badUp.json));

  const guestAnn = await guest('GET', '/api/announcements?category=finance');
  ok('游客可读班费', guestAnn.status === 200 && guestAnn.json?.items?.length >= 1);
  ok('公告署职务', guestAnn.text.includes('生活委员'));
  ok('公告不暴露 member_id', !guestAnn.text.includes('member_id'));

  const img = up.json?.url ? await guest('GET', up.json.url) : { status: 0, headers: new Headers() };
  ok('游客可读图片', img.status === 200 && img.headers?.get('content-type') === 'image/png');

  await signIn(identities.stu1.root, identities.stu1.password);
  const stuPost = await call('POST', '/api/announcements', { category: 'announcement', title: '学生不能发公告', body: '越权测试内容' });
  ok('学生无权发公告', stuPost.status === 403);

  // ---------- 举报与封禁 ----------
  step('举报与封禁');
  await signIn(identities.stu2.root, identities.stu2.password);
  const rpt = await call('POST', `/api/feedbacks/${fb1.json.id}/report`, {
    targetType: 'reply', targetId: rep3.json.reply.id, reason: '测试举报：内容需要复核',
  });
  ok('提交举报', rpt.status === 201, JSON.stringify(rpt.json));

  await signIn(identities.comm.root, identities.comm.password);
  const reports = await call('GET', '/api/admin/reports?handled=0');
  ok('班委可查看举报', reports.status === 200 && reports.json?.items?.length >= 1, JSON.stringify(reports.json));
  ok('举报详情暴露根假名（封禁所需）', reports.text.includes(identities.stu1.root), '未找到被举报作者的根假名');
  const targetMemberId = reports.json?.items?.[0]?.target?.memberId;

  const banByComm = await call('POST', `/api/admin/members/${targetMemberId}/ban`, { banned: true });
  ok('班委无权封禁', banByComm.status === 403);

  // 班委也不能借举报处理走封禁旁路（与 setBan 同一权限口径）
  const handleBanByComm = await call('POST', `/api/admin/reports/${rpt.json.id}/handle`, { action: 'ban' });
  ok('班委经举报处理执行封禁被拒', handleBanByComm.status === 403, JSON.stringify(handleBanByComm.json));

  await signIn(identities.owner.root, identities.owner.password);
  const ban = await call('POST', `/api/admin/members/${targetMemberId}/ban`, { banned: true });
  ok('维护者可封禁', ban.status === 200 && ban.json?.banned === true, JSON.stringify(ban.json));

  jar = new Map();
  const bannedLogin = await call('POST', '/api/auth/login', { name: identities.stu1.root, password: identities.stu1.password });
  ok('封禁后无法登录', bannedLogin.status === 401);

  // ---------- 审计日志 ----------
  step('审计日志');
  await signIn(identities.owner.root, identities.owner.password);
  const auditAll = await call('GET', '/api/admin/audit?limit=200');
  ok('维护者可查全量日志', auditAll.status === 200 && auditAll.json?.scope === 'all');
  for (const action of ['register', 'feedback_create', 'reply_create', 'announcement_create', 'attachment_upload', 'report_create', 'member_ban']) {
    ok(`日志覆盖 ${action}`, auditAll.text.includes(`"${action}"`));
  }
  ok('日志不含原始 IP', !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(auditAll.text));

  await signIn(identities.comm.root, identities.comm.password);
  const auditSelf = await call('GET', '/api/admin/audit?limit=200');
  ok('班委日志限定本人范围', auditSelf.status === 200 && auditSelf.json?.scope === 'self');
  const actors = new Set((auditSelf.json?.items ?? []).map((i) => i.actorName));
  ok('班委只看到自己的操作', actors.size === 1 && actors.has(identities.comm.root), [...actors].join(','));
  ok('班委看不到学生根假名', !auditSelf.text.includes(identities.stu1.root) && !auditSelf.text.includes(identities.stu2.root));

  const chainBad = await call('GET', '/api/admin/audit/verify');
  ok('班委无权校验哈希链', chainBad.status === 403);

  await signIn(identities.owner.root, identities.owner.password);
  const chain = await call('GET', '/api/admin/audit/verify');
  ok('哈希链完整', chain.status === 200 && chain.json?.chain?.ok === true, JSON.stringify(chain.json));
  ok('链行数合理', (chain.json?.chain?.count ?? 0) >= 15, `count=${chain.json?.chain?.count}`);

  // ---------- 密码重置 ----------
  step('恢复码重置密码');
  jar = new Map();
  const badReset = await call('POST', '/api/auth/reset', { name: identities.stu2.root, recoveryCode: 'WRONG-CODE-XXXX', password: 'new-pass-1234' });
  ok('错误恢复码被拒', badReset.status === 401);

  await signIn(identities.stu2.root, identities.stu2.password);
  const oldCookie = jar.get(COOKIE_NAME);
  const reset = await call('POST', '/api/auth/reset', { name: identities.stu2.root, recoveryCode: identities.stu2.recovery, password: 'brand-new-pass' });
  ok('恢复码重置成功', reset.status === 200 && !!reset.json?.recoveryCode, JSON.stringify(reset.json));
  ok('返回新恢复码且与旧的不同', reset.json?.recoveryCode !== identities.stu2.recovery);

  jar = new Map();
  const stale = await call('POST', '/api/auth/login', { name: identities.stu2.root, password: identities.stu2.password });
  ok('旧密码失效', stale.status === 401);
  const newLogin = await call('POST', '/api/auth/login', { name: identities.stu2.root, password: 'brand-new-pass' });
  ok('新密码可登录', newLogin.status === 200);

  // 保留 stu2 的新会话用于限流段；用临时罐验证旧会话已失效
  const stu2NewSession = new Map(jar);
  jar = new Map();
  jar.set(COOKIE_NAME, oldCookie);
  const meAfterReset = await call('GET', '/api/auth/me');
  ok('重置后旧会话立即失效', meAfterReset.status === 200 && meAfterReset.json?.member === null, `member=${JSON.stringify(meAfterReset.json?.member)}`);
  jar = stu2NewSession;

  // ---------- 投票 ----------
  step('投票');
  await signIn(identities.comm.root, identities.comm.password);
  const future = new Date(Date.now() + 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  const past = new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  const poll1 = await call('POST', '/api/polls', {
    title: '下周三是否组织班级聚餐', description: '费用 AA，人均约 50 元。',
    options: ['支持', '反对', '弃权'], expiresAt: future, hideResults: false,
  });
  ok('班委发起投票', poll1.status === 201, JSON.stringify(poll1.json));
  const pollHidden = await call('POST', '/api/polls', {
    title: '隐藏票数测试', description: '', options: ['A 方案', 'B 方案'],
    expiresAt: future, hideResults: true,
  });
  ok('隐藏票数投票可创建', pollHidden.status === 201, JSON.stringify(pollHidden.json));
  const pollBad = await call('POST', '/api/polls', {
    title: '选项太少', options: ['只有一项'], expiresAt: future,
  });
  ok('选项少于 2 个被拒', pollBad.status === 400, JSON.stringify(pollBad.json));
  const pollExpired = await call('POST', '/api/polls', {
    title: '已经截止的投票', options: ['是', '否'], expiresAt: past,
  });
  ok('过去的截止时间被拒', pollExpired.status === 400, JSON.stringify(pollExpired.json));

  // 注意：此处 stu2 密码已被「恢复码重置」章节改为 brand-new-pass
  await signIn(identities.stu2.root, 'brand-new-pass');
  const vote1 = await call('POST', `/api/polls/${poll1.json.id}/vote`, { optionIndex: 0 });
  ok('学生投票', vote1.status === 200 && vote1.json?.optionIndex === 0, JSON.stringify(vote1.json));
  const voteBad = await call('POST', `/api/polls/${poll1.json.id}/vote`, { optionIndex: 99 });
  ok('越界选项被拒', voteBad.status === 400, JSON.stringify(voteBad.json));
  const voteChange = await call('POST', `/api/polls/${poll1.json.id}/vote`, { optionIndex: 1 });
  ok('截止前可改票', voteChange.status === 200 && voteChange.json?.changed === true, JSON.stringify(voteChange.json));

  // stu1 已在「举报与封禁」章节被封禁，改用自定义昵称注册的账号投票
  await signIn('奶茶三分糖', 'custom-pass-1');
  await call('POST', `/api/polls/${poll1.json.id}/vote`, { optionIndex: 1 });
  const pollView1 = await call('GET', `/api/polls/${poll1.json.id}`);
  ok('票数正确聚合（改票不重复计）', pollView1.json?.poll?.totalVotes === 2
    && pollView1.json?.poll?.options?.[1]?.votes === 2, JSON.stringify(pollView1.json?.poll?.options));
  ok('详情返回我的投票', pollView1.json?.poll?.myVote === 1, `myVote=${pollView1.json?.poll?.myVote}`);

  const hiddenView = await call('GET', `/api/polls/${pollHidden.json.id}`);
  ok('隐藏票数截止前不可见', hiddenView.json?.poll?.hideResults === true
    && hiddenView.json?.poll?.totalVotes === 0, JSON.stringify(hiddenView.json?.poll));

  const guestPolls = await guest('GET', '/api/polls');
  ok('游客可读投票列表', guestPolls.status === 200 && guestPolls.json?.items?.length >= 2);
  ok('投票响应不含投票者身份', !guestPolls.text.includes('member_id') && !guestPolls.text.includes('poll_votes'));

  const guestVote = await guest('POST', `/api/polls/${poll1.json.id}/vote`, { optionIndex: 0 });
  ok('游客不能投票', guestVote.status === 401);

  // ---------- 限流 ----------
  step('限流');
  let limited = false;
  for (let i = 0; i < 60; i++) {
    const r = await call('POST', '/api/feedbacks', { title: `限流探测 ${i}`, body: '这是一条用于触发提交限流的反馈正文内容。' });
    if (r.status === 429) { limited = true; break; }
  }
  ok('提交频率超限被拦', limited);

  console.log(`\n=== 通过 ${passed} / 失败 ${failed} ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('冒烟脚本异常:', e); process.exit(1); });
