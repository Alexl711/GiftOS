'use strict';
/* Shared helpers for the public site and the admin page. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

/* ───── DOM builder ───── */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) e.style.setProperty(prop, val); else e.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowUp: '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>',
  arrowOut: '<path d="M7 17L17 7M8 7h9v9"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  gift: '<rect x="4" y="10" width="16" height="10.5" rx="1.5"/><rect x="3" y="7" width="18" height="3.5" rx="1"/><path d="M12 7v13.5M12 7c-1.6-3.5-6-3.6-5.2-.6.4 1.4 3 1.4 5.2.6zM12 7c1.6-3.5 6-3.6 5.2-.6-.4 1.4-3 1.4-5.2.6z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.8.5l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.7 1.7"/><path d="M14 10.5a4.5 4.5 0 0 0-6.8-.5l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.7-1.7"/>',
  share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/>',
  lock: '<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
};
function icon(name, size = 18, extra = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
}

/* ───── API ───── */
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

/* ───── Toasts ───── */
function toast(msg, kind) {
  let box = $('.toaster');
  if (!box) { box = h('div', { class: 'toaster', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast' }, kind === 'ok' ? icon('check', 18, 'stroke-width="2.4" style="color:var(--ok)"') : kind === 'err' ? icon('x', 18, 'stroke-width="2.4" style="color:var(--danger)"') : null, msg);
  box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); t.addEventListener('animationend', () => t.remove(), { once: true }); }, 2800);
}

/* ───── Dialogs (animated open/close) ───── */
function openDialog(d) {
  d.classList.remove('closing');
  d.showModal();
  const first = d.querySelector('[autofocus], input, textarea, button:not(.x)');
  if (first) setTimeout(() => first.focus(), 30);
}
function closeDialog(d) {
  if (!d.open || d.classList.contains('closing')) return;
  if (reduceMotion()) { d.close(); return; }
  d.classList.add('closing');
  setTimeout(() => { d.close(); d.classList.remove('closing'); }, 220);
}
function wireDialogs() {
  $$('dialog').forEach((d) => {
    d.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(d); });
    d.addEventListener('click', (e) => { if (e.target === d) closeDialog(d); });
    $$('[data-close]', d).forEach((b) => b.addEventListener('click', () => closeDialog(d)));
  });
}

/* ───── Popover menu ───── */
let openMenuEl = null;
function closeMenu() {
  if (!openMenuEl) return;
  const m = openMenuEl; openMenuEl = null;
  m.classList.add('out'); setTimeout(() => m.remove(), 140);
}
function showMenu(anchor, items) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' }, items.map((it) => it === '-' ? h('hr') :
    h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', onclick: () => { closeMenu(); it.run(); } }, icon(it.icon, 16), it.label)));
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = r.right - mw, top = r.bottom + 6, origin = 'top right';
  if (left < 8) { left = r.left; origin = 'top left'; }
  if (top + mh > innerHeight - 8) { top = r.top - mh - 6; origin = origin.replace('top', 'bottom'); }
  Object.assign(m.style, { left: left + 'px', top: top + 'px' });
  m.style.setProperty('--origin', origin);
  openMenuEl = m;
  m.querySelector('button')?.focus();
}
document.addEventListener('pointerdown', (e) => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
addEventListener('scroll', closeMenu, { passive: true });

/* ───── Segmented control with sliding thumb ───── */
function segmented(el, value, onChange) {
  let thumb = el.querySelector('.thumb');
  if (!thumb) { thumb = h('span', { class: 'thumb', 'aria-hidden': 'true' }); el.prepend(thumb); }
  const set = (v, animate) => {
    const btns = $$('button', el);
    const b = btns.find((x) => x.dataset.v === v) || btns[0];
    btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    if (!animate) thumb.style.transition = 'none';
    thumb.style.width = b.offsetWidth + 'px';
    thumb.style.transform = `translateX(${b.offsetLeft}px)`;
    if (!animate) { thumb.offsetWidth; thumb.style.transition = ''; }
  };
  $$('button', el).forEach((b) => b.addEventListener('click', () => { set(b.dataset.v, true); onChange(b.dataset.v); }));
  requestAnimationFrame(() => set(value, false));
  addEventListener('resize', () => set($$('button', el).find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.v, false));
  return set;
}

/* ───── Theme (system / light / dark) ───── */
function applyTheme(pref) {
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $$('.theme button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === pref)));
}
function wireTheme() {
  const pref = store.get('giftos_theme', 'system');
  applyTheme(pref);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('giftos_theme', 'system')));
  $$('.theme button').forEach((b) => b.addEventListener('click', () => { store.set('giftos_theme', b.dataset.v); applyTheme(b.dataset.v); }));
}
function themeToggle() {
  return h('div', { class: 'theme', role: 'group', 'aria-label': 'Theme' },
    h('button', { type: 'button', 'data-v': 'light', 'aria-label': 'Light theme', title: 'Light' }, icon('sun')),
    h('button', { type: 'button', 'data-v': 'system', 'aria-label': 'Match system', title: 'System' }, icon('monitor')),
    h('button', { type: 'button', 'data-v': 'dark', 'aria-label': 'Dark theme', title: 'Dark' }, icon('moon')));
}

/* ───── Formatting & motion ───── */
function fmtPrice(p, cur) {
  if (p == null) return '';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: p % 1 ? 2 : 0 }).format(p); }
  catch { return '$' + p; }
}
function countTo(el, target, fmt) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = target;
  if (reduceMotion() || from === target) { el.textContent = fmt(target); return; }
  const start = performance.now(), dur = 900;
  (function tick(now) {
    const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 5);
    el.textContent = fmt(from + (target - from) * e);
    if (p < 1) requestAnimationFrame(tick);
  })(start);
}
let revealIO;
function reveal(root = document) {
  const els = $$('.reveal:not(.in)', root);
  if (!('IntersectionObserver' in window) || reduceMotion()) { els.forEach((e) => e.classList.add('in')); return; }
  revealIO ||= new IntersectionObserver((entries) => entries.forEach((en) => {
    if (en.isIntersecting) { en.target.classList.add('in'); revealIO.unobserve(en.target); }
  }), { threshold: 0.06, rootMargin: '0px 0px -30px 0px' });
  const seen = new Map();
  els.forEach((e) => {
    const parent = e.parentElement;
    const i = seen.get(parent) || 0; seen.set(parent, i + 1);
    e.style.transitionDelay = Math.min(i * 55, 330) + 'ms';
    revealIO.observe(e);
  });
}
function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner' }), label ? ' ' + label : ''); }
  else { btn.disabled = false; if (btn.dataset.label != null) btn.innerHTML = btn.dataset.label; }
}
const hueOf = (s) => { let x = 7; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
