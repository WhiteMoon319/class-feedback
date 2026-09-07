// 班务平台 class-feedback · 前端公共库（vanilla，无依赖）

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
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
  ];
  if (me) links.push(['/mine', '我的反馈']);
  if (isCommittee()) links.push(['/admin', '管理']);
  header.innerHTML = `
    <div class="inner">
      <a class="brand" href="/">班务平台</a>
      <nav class="nav">${links.map(([href, label]) =>
        `<a href="${href}" ${active === href ? 'aria-current="page"' : ''}>${label}</a>`).join('')}
      </nav>
      ${me
        ? `<a href="/mine" title="已登录" style="color:var(--c-text-2);font-size:13px;white-space:nowrap">${escapeHtml(me.displayName)}</a>
           <button class="btn btn-sm" id="logoutBtn" type="button" title="退出登录" style="white-space:nowrap">退出</button>`
        : '<a href="/login" class="btn btn-sm" style="white-space:nowrap">登录</a>'}
      <button class="theme-btn" id="themeBtn" title="切换深浅色" aria-label="切换深浅色">◐</button>
    </div>`;

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
