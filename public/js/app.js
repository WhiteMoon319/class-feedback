// 班务平台 class-feedback · 前端公共库（vanilla，无依赖）

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg) {
  let el = $('#toast');
  if (el) {
    clearTimeout(el._t);
    clearTimeout(el._lt);
    el.classList.remove('leaving');
  } else {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  // 强制重排，确保移除 leaving 后入场过渡从头开始
  void el.offsetWidth;
  el.classList.add('show');
  el._t = setTimeout(() => {
    el.classList.add('leaving');
    el._lt = setTimeout(() => el.classList.remove('show', 'leaving'), 160);
  }, 2600);
}

/** 列表加载骨架（rows 行灰条），配合 prefers-reduced-motion 自动降级为静态 */
export function skeleton(rows = 3) {
  const lines = Array.from({ length: rows }, () => '<div class="skeleton-line"></div>').join('');
  return `<div class="skeleton">${lines}</div>`;
}

/** 错误态：红边框 + 消息 + 重试按钮（onRetry 返回 Promise，点击后回到骨架） */
export function errorBox(message, onRetry) {
  return `
    <div class="error">
      ${escapeHtml(message || '加载失败')}
      ${onRetry ? `<br><button class="btn btn-sm" id="retryBtn" type="button">重试</button>` : ''}
    </div>`;
}

/** 内联二次确认：首次点击进入待确认态（变红+文案变化），5 秒未确认自动还原。
 *  替代原生 confirm()，保持 UI 语言一致。 */
export function armDangerButton(btn, action, confirmText = '再点一次确认') {
  const original = btn.textContent;
  if (btn.dataset.armed === '1') { action(); return; }
  btn.dataset.armed = '1';
  btn.textContent = confirmText;
  btn.classList.add('btn-danger');
  clearTimeout(btn._arm);
  btn._arm = setTimeout(() => {
    btn.dataset.armed = '0';
    btn.textContent = original;
    btn.classList.remove('btn-danger');
  }, 5000);
}

export async function api(method, path, body, opts = {}) {
  const headers = {};
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) {
    if (res.status === 401 && !opts.silent) {
      sessionStorage.setItem('cf_after_login', location.pathname + location.search);
    }
    const err = new Error(json?.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.code = json?.code;
    throw err;
  }
  return json;
}

const ME_KEY = 'cf_me';
export function cachedMe() {
  try { return JSON.parse(localStorage.getItem(ME_KEY)); } catch { return null; }
}
export function setCachedMe(me) {
  if (me) localStorage.setItem(ME_KEY, JSON.stringify(me));
  else localStorage.removeItem(ME_KEY);
}

/** 页面加载时确认登录态；401 不算错误，静默清缓存。成功后重渲染导航，
    避免「cookie 有效但本地缓存被清」时导航栏与实际会话不一致 */
export async function refreshMe() {
  try {
    const r = await api('GET', '/api/auth/me', undefined, { silent: true });
    setCachedMe(r.member);
    if (r.member) renderHeader(document.body.dataset.nav || '/');
    return r.member;
  } catch (e) {
    setCachedMe(null);
    return null;
  }
}

export function isCommittee() {
  const me = cachedMe();
  return me?.role === 'committee' || me?.role === 'owner';
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STATUS_TEXT = { pending: '待处理', in_review: '处理中', resolved: '已解决' };
const CATEGORY_TEXT = { announcement: '公告', finance: '班费', minutes: '决议' };

export function statusBadge(status) {
  return `<span class="badge badge-${escapeHtml(status)}">${STATUS_TEXT[status] || escapeHtml(status)}</span>`;
}

export function categoryBadge(a) {
  if (a.category === 'finance' && a.direction === 'expense') {
    return '<span class="badge badge-finance-expense">班费支出</span>';
  }
  if (a.category === 'finance') return '<span class="badge badge-finance">班费收入</span>';
  return `<span class="badge badge-committee">${CATEGORY_TEXT[a.category] || ''}</span>`;
}

const dtf = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
/** UTC 时间戳 → 本地显示（数据库存 UTC，浏览器 Intl 自动转到本机时区） */
export function fmtTime(utc) {
  if (!utc) return '';
  return dtf.format(new Date(utc.replace(' ', 'T') + 'Z'));
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

/** 头部导航 + 主题按钮。页面只需在 body 里放 <header class="site-header"></header> */
export function renderHeader(active) {
  const header = $('header.site-header');
  if (!header) return;
  const me = cachedMe();
  const links = [
    ['/', '首页'],
    ['/feedbacks', '反馈广场'],
    ['/announcements', '班务公开'],
    ['/polls', '投票'],
  ];
  if (me) links.push(['/mine', '我的反馈']);
  if (isCommittee()) links.push(['/admin', '管理']);
  const userArea = me
    ? `<a class="header-user" href="/mine" title="已登录">${escapeHtml(me.displayName)}</a>
       <button class="btn btn-sm" id="logoutBtn" type="button" title="退出登录">退出</button>`
    : '<a class="btn btn-sm" id="loginBtn" href="/login">登录</a>';
  header.innerHTML = `
    <div class="inner">
      <a class="brand" href="/">班务平台</a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="navLinks" aria-label="打开菜单">
        <span></span><span></span><span></span>
      </button>
      <nav class="nav" id="navLinks">
        ${links.map(([href, label]) =>
          `<a class="nav-item" href="${href}" ${active === href ? 'aria-current="page"' : ''}>${label}</a>`).join('')}
        <span class="nav-spacer" aria-hidden="true"></span>
        ${userArea}
      </nav>
      <button class="theme-btn" id="themeBtn" title="切换深浅色" aria-label="切换深浅色">◐</button>
    </div>`;

  // 汉堡菜单：menu-open 加在 header 上（汉堡按钮与抽屉都是其子孙，选择器统一命中）
  const nav = $('#navLinks');
  const toggle = header.querySelector('.nav-toggle');
  const closeMenu = () => {
    header.classList.remove('menu-open');
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.addEventListener('click', () => {
    const open = header.classList.toggle('menu-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  // 点菜单项 / Esc / 点面板外区域均关闭
  nav.addEventListener('click', (e) => { if (e.target.closest('a, button')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  document.addEventListener('click', (e) => {
    if (header.classList.contains('menu-open')
      && !e.target.closest('#navLinks') && !e.target.closest('.nav-toggle')) closeMenu();
  });

  const lo = $('#logoutBtn');
  if (lo) {
    lo.addEventListener('click', async () => {
      try { await api('POST', '/api/auth/logout'); } catch { /* 会话已失效也无妨 */ }
      setCachedMe(null);
      location.href = '/';
    });
  }

  const btn = $('#themeBtn');
  const apply = (mode) => {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = mode;
  };
  apply(localStorage.getItem('cf-theme') || 'auto');
  btn.addEventListener('click', () => {
    const cur = localStorage.getItem('cf-theme') || 'auto';
    const next = { auto: 'light', light: 'dark', dark: 'auto' }[cur];
    localStorage.setItem('cf-theme', next);
    apply(next);
  });
}

export function renderFooter() {
  const f = $('footer.site-footer');
  if (!f) return;
  f.innerHTML = `
    <a href="/about">关于与隐私</a>
    <span>匿名反馈 · 班务公开</span>
    <span style="margin-left:auto">数据仅存于本班 Cloudflare，不收集真实身份</span>`;
}

/** 页内返回链接：不依赖浏览器历史。
 *  优先回到站内来源页（如从「我的反馈」进入则返回我的反馈），
 *  无来源（直接输 URL）时回默认列表页。 */
export function renderBackLink(defaultHref, defaultLabel) {
  let href = defaultHref;
  let label = defaultLabel;
  try {
    const ref = document.referrer;
    if (ref) {
      const u = new URL(ref);
      if (u.origin === location.origin && u.pathname !== location.pathname) {
        href = ref;
        if (u.pathname.includes('/mine')) label = '返回我的反馈';
        else if (u.pathname.includes('/feedbacks')) label = '返回反馈广场';
        else if (u.pathname.includes('/announcements')) label = '返回班务公开';
        else if (u.pathname.includes('/polls')) label = '返回投票';
      }
    }
  } catch { /* 跨源或不合法 referrer，保持默认 */ }
  const el = document.createElement('a');
  el.className = 'back-link';
  el.href = href;
  el.textContent = `← ${label}`;
  return el;
}

export function requireLoginPage() {
  if (!cachedMe()) {
    sessionStorage.setItem('cf_after_login', location.pathname + location.search);
    location.href = '/login';
    return false;
  }
  return true;
}

export function afterLoginGo() {
  const dest = sessionStorage.getItem('cf_after_login') || '/mine';
  sessionStorage.removeItem('cf_after_login');
  location.href = dest;
}

export function init() {
  const fav = document.createElement('link');
  fav.rel = 'icon';
  fav.href = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="%232f6fed"/><text x="16" y="22" font-size="16" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="700">班</text></svg>',
  );
  document.head.appendChild(fav);
  renderHeader(document.body.dataset.nav || '/');
  renderFooter();
}
