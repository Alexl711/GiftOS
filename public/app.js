'use strict';

/* ═══════════════ STATE ═══════════════ */
const S = {
  owner: false,
  settings: {},
  items: [],
  cat: 'All',
  loaded: false,
};
const $ = (id) => document.getElementById(id);
const CAT_ICONS = { Golf: '⛳️', Shoes: '👟', Tech: '📱', Apparel: '👕', Fragrance: '🌿', Fitness: '🥋', Home: '🏠', Books: '📚', Other: '🎁' };

/* Local-only conveniences, wrapped because storage can be unavailable. */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
// Reservation tokens prove "I reserved this" so only that person can release it.
const myReservations = () => store.get('giftos_reservations', {});
const setMyReservation = (id, token) => {
  const r = myReservations();
  if (token) r[id] = token; else delete r[id];
  store.set('giftos_reservations', r);
};

/* ═══════════════ API ═══════════════ */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && S.owner && path !== '/api/login') setOwner(false);
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

async function load(announce) {
  try {
    const d = await api('/api/state');
    S.settings = d.settings;
    S.items = d.items;
    S.loaded = true;
    setOwner(d.owner, true);
    renderAll();
    if (announce) toast('List refreshed');
  } catch (e) {
    toast(e.message || 'Couldn’t load the list');
    if (!S.loaded) $('grid').replaceChildren(h('div', { class: 'empty' }, h('b', { text: 'Couldn’t load the list' }), 'Check your connection and refresh.'));
  }
}

function upsert(item) {
  const i = S.items.findIndex((x) => x.id === item.id);
  if (i > -1) S.items[i] = item; else S.items.unshift(item);
}

/* ═══════════════ RENDER ═══════════════ */
function renderAll() {
  renderHero(); renderChips(); renderNav(); renderStats(); renderGrid(); renderCatList();
}

function renderHero() {
  const s = S.settings;
  $('hTitle').textContent = s.title || 'Wishlist';
  $('hHeadline').textContent = s.headline || '';
  $('hSub').textContent = s.subtitle || '';
}

function categories() {
  const counts = {};
  S.items.forEach((i) => { counts[i.category] = (counts[i.category] || 0) + 1; });
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b)).map((c) => [c, counts[c]]);
}

function renderChips() {
  const cats = categories();
  if (S.cat !== 'All' && !cats.some(([c]) => c === S.cat)) S.cat = 'All';
  const chip = (c, n) => h('button', {
    class: 'chip' + (c === S.cat ? ' on' : ''), type: 'button', 'aria-pressed': String(c === S.cat),
    onclick: () => { S.cat = c; renderChips(); renderGrid(); },
  }, c, n != null ? h('span', { class: 'n', text: n }) : null);
  $('chips').replaceChildren(chip('All', S.items.length), ...cats.map(([c, n]) => chip(c, n)));
}

function renderNav() {
  $('navLinks').replaceChildren(...categories().slice(0, 5).map(([c]) =>
    h('a', { href: '#grid', text: c, onclick: () => { S.cat = c; renderChips(); renderGrid(); } })));
}

function renderCatList() {
  const all = [...new Set([...Object.keys(CAT_ICONS), ...categories().map(([c]) => c)])];
  $('catList').replaceChildren(...all.map((c) => h('option', { value: c })));
}

function renderStats() {
  const items = S.items;
  countTo($('stItems'), items.length, (v) => Math.round(v));
  countTo($('stOpen'), items.filter((i) => !i.reserved).length, (v) => Math.round(v));
  countTo($('stValue'), items.reduce((s, i) => s + (i.price || 0), 0), (v) => '$' + Math.round(v).toLocaleString());
}

function countTo(el, target, fmt) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(target); return; }
  const from = Number(el.dataset.v || 0), start = performance.now(), dur = 700;
  el.dataset.v = target;
  (function tick(now) {
    const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (target - from) * e);
    if (p < 1) requestAnimationFrame(tick);
  })(start);
}

const surprise = () => S.owner && document.body.classList.contains('surprise');
// In surprise mode, the owner sees every item as if it were unreserved.
const isReservedForView = (i) => i.reserved && !surprise();

function filtered() {
  const q = $('search').value.trim().toLowerCase();
  const sort = $('sort').value;
  const newest = (a, b) => b.createdAt - a.createdAt;
  const by = {
    star: (a, b) => (b.starred - a.starred) || (isReservedForView(a) - isReservedForView(b)) || newest(a, b),
    new: newest,
    open: (a, b) => (isReservedForView(a) - isReservedForView(b)) || newest(a, b),
    hi: (a, b) => (b.price ?? -1) - (a.price ?? -1),
    lo: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
    az: (a, b) => a.title.localeCompare(b.title),
  };
  return S.items
    .filter((i) => (S.cat === 'All' || i.category === S.cat) &&
      (!q || [i.title, i.source, i.category, i.notes].join(' ').toLowerCase().includes(q)))
    .sort(by[sort] || by.star);
}

function renderGrid() {
  const list = filtered();
  const grid = $('grid');
  if (!list.length) {
    const searching = $('search').value.trim() || S.cat !== 'All';
    grid.replaceChildren(h('div', { class: 'empty' },
      h('b', { text: searching ? 'No matches' : 'Nothing here yet' }),
      searching ? 'Try a different search or category.'
        : S.owner ? 'Paste a product link above to start your list.' : 'Check back soon. The list is being put together.'));
    return;
  }
  grid.replaceChildren(...list.map(cardEl));
  reveal();
}

function cardEl(i) {
  const owner = S.owner;
  const reserved = isReservedForView(i);
  const mine = !owner && i.reserved && myReservations()[i.id];
  const buyUrl = i.url || 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(i.title);

  // image
  const ph = () => h('span', { class: 'ph', 'aria-hidden': 'true', text: CAT_ICONS[i.category] || CAT_ICONS.Other });
  const imgWrap = h('div', { class: 'card-img' });
  if (i.image) {
    const img = h('img', { src: i.image, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(ph()), { once: true });
    img.addEventListener('click', () => zoom(img.src));
    imgWrap.append(img);
  } else imgWrap.append(ph());

  if (reserved) imgWrap.append(h('span', { class: 'badge', text: mine ? 'Reserved by you' : 'Reserved' }));
  else if (i.starred && !owner) imgWrap.append(h('span', { class: 'badge want', text: 'Most wanted' }));
  if (owner) {
    imgWrap.append(h('button', {
      class: 'star-flag' + (i.starred ? ' on' : ''), type: 'button', text: '★',
      'aria-pressed': String(i.starred), 'aria-label': 'Most wanted',
      title: i.starred ? 'Unmark most wanted' : 'Mark most wanted',
      onclick: () => toggleStar(i),
    }));
  }

  // body
  const body = h('div', { class: 'card-body' },
    h('span', { class: 'card-cat', text: i.category }),
    h('h3', { class: 'card-title' }, h('a', { href: buyUrl, target: '_blank', rel: 'noopener noreferrer', text: i.title })),
    i.notes ? h('p', { class: 'card-notes', text: i.notes }) : null,
    owner && reserved ? h('p', { class: 'reserved-note', text: 'Reserved by ' + (i.reservedBy || 'someone') }) : null,
    h('div', { class: 'card-meta' },
      h('span', { class: 'card-price', text: i.price != null ? fmtPrice(i.price, i.currency) : '' }),
      h('span', { class: 'card-src', text: i.source || '' })),
  );

  // actions
  const actions = h('div', { class: 'card-actions' });
  if (owner) {
    actions.append(
      h('a', { class: 'act', href: buyUrl, target: '_blank', rel: 'noopener noreferrer', text: 'View' }),
      h('button', { class: 'act', type: 'button', text: 'Edit', onclick: () => openEdit(i) }),
      h('button', { class: 'act del', type: 'button', text: 'Remove', onclick: () => removeItem(i) }),
    );
  } else {
    actions.append(h('a', { class: 'act primary', href: buyUrl, target: '_blank', rel: 'noopener noreferrer', text: 'View at store' }));
    if (mine) actions.append(h('button', { class: 'act mine', type: 'button', text: 'Undo reserve', onclick: () => unreserve(i) }));
    else if (i.reserved) actions.append(h('button', { class: 'act', type: 'button', text: 'Taken', disabled: true }));
    else actions.append(h('button', { class: 'act', type: 'button', text: 'Reserve', onclick: () => openReserve(i) }));
  }

  return h('article', { class: 'card' + (reserved ? ' is-reserved' : ''), 'data-reveal': '' }, imgWrap, body, actions);
}

/* ═══════════════ OWNER ═══════════════ */
function setOwner(on, silent) {
  S.owner = !!on;
  document.body.classList.toggle('owner', S.owner);
  document.body.classList.toggle('surprise', S.owner && store.get('giftos_surprise', false));
  $('surpriseToggle').checked = store.get('giftos_surprise', false);
  $('lockBtn').setAttribute('aria-label', S.owner ? 'Sign out of owner mode' : 'Owner sign-in');
  $('lockBtn').title = S.owner ? 'Owner mode on. Click to sign out' : 'Owner sign-in';
  if (!silent) renderAll();
}

async function signIn(e) {
  e.preventDefault();
  const btn = $('loginGo');
  busy(btn, 'Checking');
  try {
    await api('/api/login', { method: 'POST', body: { password: $('pwInput').value } });
    $('loginModal').close();
    $('pwInput').value = '';
    await load();
    toast('Owner mode on');
  } catch (err) {
    toast(err.message); $('pwInput').select();
  } finally { unbusy(btn, 'Unlock'); }
}

async function signOut() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* cookie may already be gone */ }
  await load();
  toast('Signed out');
}

async function addFromUrl(e) {
  e.preventDefault();
  const input = $('urlInput'), url = input.value.trim();
  if (!/^https?:\/\//i.test(url)) { toast('Paste a full link, starting with https://'); input.focus(); return; }
  const btn = $('addBtn');
  busy(btn, 'Adding');
  try {
    const { item } = await api('/api/items', { method: 'POST', body: { url } });
    upsert(item); input.value = ''; renderAll();
    toast('Added. Check the details look right');
    if (!item.image || item.price == null) openEdit(item);
  } catch (err) { toast(err.message); }
  finally { unbusy(btn, 'Add'); }
}

async function bulkImport(e) {
  e.preventDefault();
  const btn = $('bulkGo');
  busy(btn, 'Importing');
  try {
    const r = await api('/api/items/bulk', { method: 'POST', body: { text: $('bulkText').value } });
    $('bulkModal').close(); $('bulkText').value = '';
    await load();
    const bits = [`Added ${r.added}`];
    if (r.skipped) bits.push(`${r.skipped} already on the list`);
    if (r.failed) bits.push(`${r.failed} failed`);
    toast(bits.join(' · '));
  } catch (err) { toast(err.message); }
  finally { unbusy(btn, 'Import'); }
}

let editing = null; // null = creating a manual item
function openEdit(i) {
  editing = i || null;
  $('editH').textContent = i ? 'Edit item' : 'Add without a link';
  $('editSave').textContent = i ? 'Save' : 'Add to list';
  $('eTitle').value = i?.title || '';
  $('eUrl').value = i?.url || '';
  $('eImage').value = i?.rawImage || '';
  $('ePrice').value = i?.price ?? '';
  $('eCurrency').value = i?.currency || 'USD';
  $('eCategory').value = i?.category || '';
  $('eNotes').value = i?.notes || '';
  $('eStar').checked = !!i?.starred;
  const line = $('eReserved');
  if (i?.reserved && !surprise()) {
    line.hidden = false;
    line.replaceChildren(h('span', { text: 'Reserved by ' + (i.reservedBy || 'someone') }),
      h('button', { class: 'linkish', type: 'button', text: 'Release', onclick: () => ownerRelease(i) }));
  } else line.hidden = true;
  $('editModal').showModal();
}

function formFields() {
  return {
    title: $('eTitle').value.trim(), url: $('eUrl').value.trim(), image: $('eImage').value.trim(),
    price: $('ePrice').value.trim(), currency: $('eCurrency').value.trim() || 'USD',
    category: $('eCategory').value.trim() || 'Other', notes: $('eNotes').value.trim(), starred: $('eStar').checked,
  };
}

async function saveEdit(e) {
  e.preventDefault();
  const btn = $('editSave'), label = btn.textContent;
  busy(btn, 'Saving');
  try {
    const { item } = editing
      ? await api('/api/items/' + editing.id, { method: 'PATCH', body: formFields() })
      : await api('/api/items', { method: 'POST', body: { manual: true, ...formFields() } });
    upsert(item); renderAll();
    $('editModal').close(); toast(editing ? 'Saved' : 'Added to the list');
  } catch (err) { toast(err.message); }
  finally { unbusy(btn, label); }
}

async function toggleStar(i) {
  try {
    const body = { ...i, image: i.rawImage, starred: !i.starred };
    const { item } = await api('/api/items/' + i.id, { method: 'PATCH', body });
    upsert(item); renderGrid();
  } catch (err) { toast(err.message); }
}

async function removeItem(i) {
  if (!confirm(`Remove “${i.title}” from the list?`)) return;
  try {
    await api('/api/items/' + i.id, { method: 'DELETE' });
    S.items = S.items.filter((x) => x.id !== i.id);
    renderAll(); toast('Removed');
  } catch (err) { toast(err.message); }
}

async function ownerRelease(i) {
  if (!confirm('Release this reservation? The gift-giver who reserved it won’t be notified.')) return;
  try {
    const { item } = await api(`/api/items/${i.id}/reserve`, { method: 'DELETE' });
    upsert(item); renderAll(); $('editModal').close(); toast('Reservation released');
  } catch (err) { toast(err.message); }
}

function openSettings() {
  $('sTitle').value = S.settings.title || '';
  $('sHeadline').value = S.settings.headline || '';
  $('sSub').value = S.settings.subtitle || '';
  $('settingsModal').showModal();
}

async function saveSettings(e) {
  e.preventDefault();
  const btn = $('settingsSave');
  busy(btn, 'Saving');
  try {
    const { settings } = await api('/api/settings', { method: 'PUT', body: {
      title: $('sTitle').value, headline: $('sHeadline').value, subtitle: $('sSub').value } });
    S.settings = settings; renderHero(); $('settingsModal').close(); toast('Saved');
  } catch (err) { toast(err.message); }
  finally { unbusy(btn, 'Save'); }
}

async function share() {
  const url = location.origin + '/';
  const title = S.settings.title || 'My wishlist';
  try {
    if (navigator.share) { await navigator.share({ title, url }); return; }
    await navigator.clipboard.writeText(url);
    toast('Link copied. Send it to anyone');
  } catch (err) {
    if (err?.name !== 'AbortError') prompt('Copy this link:', url);
  }
}

/* ═══════════════ GIFT-GIVERS ═══════════════ */
let reserving = null;
function openReserve(i) {
  reserving = i;
  $('reserveH').textContent = `Reserve “${i.title}”`;
  $('rName').value = store.get('giftos_name', '');
  $('reserveModal').showModal();
  $('rName').focus();
}

async function confirmReserve(e) {
  e.preventDefault();
  if (!reserving) return;
  const btn = $('reserveGo'), name = $('rName').value.trim();
  busy(btn, 'Reserving');
  try {
    const { token, item } = await api(`/api/items/${reserving.id}/reserve`, { method: 'POST', body: { name } });
    setMyReservation(item.id, token);
    if (name) store.set('giftos_name', name);
    upsert(item); renderAll();
    $('reserveModal').close();
    toast('Reserved. Thank you!');
  } catch (err) {
    toast(err.message);
    if (/just reserved|no longer/.test(err.message)) { $('reserveModal').close(); load(); }
  } finally { unbusy(btn, 'Reserve it'); reserving = null; }
}

async function unreserve(i) {
  if (!confirm('Free this gift back up so someone else can get it?')) return;
  try {
    const { item } = await api(`/api/items/${i.id}/reserve`, { method: 'DELETE', body: { token: myReservations()[i.id] } });
    setMyReservation(i.id, null);
    upsert(item); renderAll(); toast('Released');
  } catch (err) { toast(err.message); }
}

/* ═══════════════ HELPERS ═══════════════ */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

function fmtPrice(p, cur) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: p % 1 ? 2 : 0 }).format(p); }
  catch { return '$' + p; }
}

function zoom(src) { $('lightboxImg').src = src; $('lightbox').showModal(); }

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function busy(btn, label) { btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin' }), label + '…'); }
function unbusy(btn, label) { btn.disabled = false; btn.textContent = label; }

function reveal() {
  const els = document.querySelectorAll('[data-reveal]:not(.in)');
  if (!('IntersectionObserver' in window)) { els.forEach((el) => el.classList.add('in')); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
  }, { threshold: 0.05 });
  els.forEach((el, i) => { el.style.transitionDelay = Math.min(i * 40, 240) + 'ms'; io.observe(el); });
}

/* ═══════════════ WIRING ═══════════════ */
$('yr').textContent = new Date().getFullYear();
$('sort').value = store.get('giftos_sort', 'star');

document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // backdrop click
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
});
$('lightbox').addEventListener('click', () => $('lightbox').close());

$('lockBtn').addEventListener('click', () => {
  if (S.owner) signOut(); else { $('loginModal').showModal(); $('pwInput').focus(); }
});
$('signOutBtn').addEventListener('click', signOut);
$('loginForm').addEventListener('submit', signIn);
$('addForm').addEventListener('submit', addFromUrl);
$('bulkBtn').addEventListener('click', () => $('bulkModal').showModal());
$('bulkForm').addEventListener('submit', bulkImport);
$('manualBtn').addEventListener('click', () => openEdit(null));
$('editForm').addEventListener('submit', saveEdit);
$('settingsBtn').addEventListener('click', openSettings);
$('settingsForm').addEventListener('submit', saveSettings);
$('reserveForm').addEventListener('submit', confirmReserve);
$('navShare').addEventListener('click', share);
$('refreshBtn').addEventListener('click', () => load(true));
$('search').addEventListener('input', renderGrid);
$('sort').addEventListener('change', () => { store.set('giftos_sort', $('sort').value); renderGrid(); });
$('surpriseToggle').addEventListener('change', (e) => {
  store.set('giftos_surprise', e.target.checked);
  document.body.classList.toggle('surprise', e.target.checked);
  renderAll();
  toast(e.target.checked ? 'Surprise mode on. Reservations are hidden from you' : 'Surprise mode off');
});

// Keep the list fresh when someone comes back to the tab (e.g., after buying).
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.loaded) load(); });

load();
