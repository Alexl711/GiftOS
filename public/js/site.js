'use strict';
/* Public wishlist page. */

const S = { settings: {}, items: [], query: '', budget: store.get('giftos_budget', 'low'), loaded: false };
const BUDGETS = { low: [0, 50], mid: [50, 150], high: [150, Infinity] };

/* ───── Secret Santa note ─────
   A friendly one-time pop-up when a budget is set in admin. No filtering, and the amount is never shown. */
const budgetOn = () => !!S.settings.budget_on;
const budgetSeenKey = 'giftos_budget_note_seen';
function budgetMessage() {
  return (S.settings.budget_note || '').trim() ||
    'Some things on here are pricier because this is my everyday wishlist too, so feel free to skip those. Anything that fits our Secret Santa budget would make my day!';
}
function maybeShowBudgetPopup() {
  if (!budgetOn() || store.get(budgetSeenKey, false)) return;
  $('#budgetMsg').textContent = budgetMessage();
  setTimeout(() => openDialog($('#budgetDlg')), 600);
}

const mine = () => store.get('giftos_reservations', {});
const setMine = (id, token) => { const r = mine(); if (token) r[id] = token; else delete r[id]; store.set('giftos_reservations', r); };

/* ───── Load ───── */
async function load(quiet) {
  try {
    const d = await api('/api/list');
    S.settings = d.settings; S.items = d.items; S.loaded = true;
    // Forget reservations that no longer exist (e.g. the owner released them).
    const r = mine(); let changed = false;
    for (const id of Object.keys(r)) { const it = S.items.find((i) => i.id === id); if (!it || !it.reserved) { delete r[id]; changed = true; } }
    if (changed) store.set('giftos_reservations', r);
    renderHero(); renderSections();
    maybeShowBudgetPopup();
  } catch (e) {
    if (!quiet) toast(e.message, 'err');
    if (!S.loaded) $('#sections').replaceChildren(emptyState('Couldn’t load the list', 'Check your connection and refresh the page.'));
  }
}

/* ───── Hero ───── */
function renderHero() {
  const s = S.settings;
  const initial = (s.name || s.title || 'W').trim().charAt(0).toUpperCase();
  $('#avatar').textContent = initial; $('#logoMark').textContent = initial;
  $('#logoName').textContent = s.title || 'Wishlist';
  $('#title').textContent = s.title || 'Wishlist';
  $('#tagline').textContent = s.tagline || '';
  $('#message').textContent = s.message || '';
  document.title = s.title || 'Wishlist';

  const ev = $('#event');
  const days = daysUntil(s.event_date);
  if (s.event_name && days != null && days >= 0) {
    ev.hidden = false;
    ev.replaceChildren(icon('calendar', 15), s.event_name + ' · ', h('b', { text: days === 0 ? 'today!' : days === 1 ? 'tomorrow' : `in ${days} days` }));
  } else ev.hidden = true;

  const linked = S.items.filter((i) => i.url);
  const prices = linked.map((i) => i.price).filter((p) => p != null);
  countTo($('#stItems'), S.items.length, (v) => Math.round(v));
  countTo($('#stOpen'), S.items.filter((i) => !i.reserved).length, (v) => Math.round(v));
  $('#stRange').textContent = prices.length ? (Math.min(...prices) === Math.max(...prices) ? fmtPrice(prices[0], 'USD')
    : `${fmtShort(Math.min(...prices))}–${fmtShort(Math.max(...prices))}`) : '–';
}
const fmtShort = (n) => '$' + (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : Math.round(n));
function daysUntil(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(y, m - 1, d), now = new Date();
  return Math.round((t - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
}

/* ───── Sections ───── */
function renderSections() {
  const root = $('#sections');
  const q = S.query.trim().toLowerCase();
  const items = S.items;
  const out = [];
  const pills = [];

  if (!items.length) {
    root.replaceChildren(emptyState('The list is being put together', 'Check back soon. New things are on the way.', 'gift'));
    $('#jumpPills').replaceChildren(); return;
  }

  if (q) {
    const hits = items.filter((i) => [i.title, i.source, i.category, i.notes].join(' ').toLowerCase().includes(q));
    out.push(section('results', 'Results', hits.length, null,
      hits.length ? h('div', { class: 'grid' }, hits.map((i) => card(i))) : emptyState('No matches', `Nothing matches “${S.query}”. Try another word.`, 'search')));
    root.replaceChildren(...out); reveal(root); return;
  }

  const linked = items.filter((i) => i.url);
  const ideas = items.filter((i) => !i.url);
  const wanted = linked.filter((i) => i.starred);

  if (wanted.length) {
    out.push(section('wanted', 'Most wanted', wanted.length, 'The ones at the very top of the list.',
      h('div', { class: 'grid featured' }, sortAvail(wanted).map((i) => card(i, 'feature')))));
    pills.push(['wanted', 'Most wanted']);
  }

  // Suggestions by budget: only things still available.
  const avail = linked.filter((i) => !i.reserved && i.price != null);
  if (avail.length >= 3) {
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Budget' },
      h('button', { type: 'button', 'data-v': 'low' }, 'Under $50'),
      h('button', { type: 'button', 'data-v': 'mid' }, '$50–150'),
      h('button', { type: 'button', 'data-v': 'high' }, '$150+'));
    const surprise = h('button', { class: 'btn soft sm', type: 'button', onclick: surpriseMe }, icon('sparkle', 15), 'Surprise me');
    const shelf = h('div', { class: 'shelf', id: 'shelf' });
    const fill = (animate) => {
      const [lo, hi] = BUDGETS[S.budget];
      const picks = avail.filter((i) => i.price >= lo && i.price < hi).sort((a, b) => a.price - b.price);
      shelf.classList.toggle('swap', !!animate);
      shelf.replaceChildren(...(picks.length ? picks.map((i) => card(i, 'compact')) : [h('div', { class: 'shelf-empty', style: { gridColumn: '1/-1', width: 'min(520px,80vw)' }, text: 'Nothing available in this range right now. Try another.' })]));
      if (animate) $$('.reveal', shelf).forEach((e) => { e.classList.add('in'); e.style.transitionDelay = ''; });
      else reveal(shelf);
      shelf.scrollTo({ left: 0 });
    };
    fill(false);
    out.push(section('ideas-budget', 'Gift ideas by budget', avail.length, 'Still available, sorted by price.', shelf, [seg, surprise]));
    requestAnimationFrame(() => segmented(seg, S.budget, (v) => { S.budget = v; store.set('giftos_budget', v); fill(true); }));
    pills.push(['ideas-budget', 'By budget']);
  }

  // One section per category (most wanted are already shown above).
  const byCat = new Map();
  for (const i of linked.filter((x) => !x.starred)) { if (!byCat.has(i.category)) byCat.set(i.category, []); byCat.get(i.category).push(i); }
  const cats = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  for (const [cat, list] of cats) {
    const id = 'cat-' + cat.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    out.push(section(id, cat, list.length, null, h('div', { class: 'grid' }, sortAvail(list).map((i) => card(i)))));
    pills.push([id, cat]);
  }

  if (ideas.length) {
    out.push(section('other-ideas', 'Other ideas', ideas.length, 'No link needed. These are things I’d love too.',
      h('div', { class: 'ideas' }, ideas.map(ideaCard))));
    pills.push(['other-ideas', 'Other ideas']);
  }

  root.replaceChildren(...out);
  $('#jumpPills').replaceChildren(...pills.map(([id, label]) =>
    h('a', { class: 'pill', href: '#' + id, 'data-target': id }, label)));
  spy();
  reveal(root);
}

const sortAvail = (list) => [...list].sort((a, b) => (a.reserved - b.reserved) || (b.createdAt - a.createdAt));

function section(id, title, count, sub, body, tools) {
  return h('section', { class: 'section', id, 'aria-labelledby': id + '-h' },
    h('div', { class: 'sec-head reveal' },
      h('div', { class: 'sec-title' }, h('h2', { id: id + '-h', text: title }), count != null ? h('span', { class: 'count', text: String(count).padStart(2, '0') }) : null),
      tools ? h('div', { class: 'sec-tools' }, tools) : null,
      sub ? h('p', { text: sub }) : null),
    body);
}

function emptyState(title, text, ic = 'gift') {
  return h('div', { class: 'empty-state' }, h('div', { class: 'ic' }, icon(ic, 24)), h('b', { text: title }), text);
}

/* ───── Cards ───── */
function card(i, variant) {
  const isMine = i.reserved && !!mine()[i.id];
  const tile = h('a', { class: 'tile' + (i.image ? '' : ' empty'), href: i.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${i.title} at ${i.source || 'the store'}` });
  if (i.image) {
    const img = h('img', { src: i.image, alt: '', loading: 'lazy', decoding: 'async' });
    // If our image relay is refused, let the browser load the store's photo directly.
    img.addEventListener('error', function onErr() {
      if (i.imageDirect && img.src !== i.imageDirect) { img.referrerPolicy = 'no-referrer'; img.src = i.imageDirect; return; }
      img.removeEventListener('error', onErr);
      tile.classList.add('empty'); img.replaceWith(icon('gift', 44, 'class="ph" stroke-width="1.2"'));
    });
    tile.append(img);
  } else tile.append(icon('gift', 44, 'class="ph" stroke-width="1.2"'));
  tile.append(h('span', { class: 'go' }, 'View at store', icon('arrowOut', 13)));
  if (isMine) tile.append(h('span', { class: 'flag mine' }, icon('check', 13, 'stroke-width="2.6"'), 'You’re getting this'));
  else if (i.reserved) tile.append(h('span', { class: 'flag taken', text: 'Reserved' }));
  else if (i.starred && variant !== 'feature') tile.append(h('span', { class: 'flag want' }, icon('star', 12), 'Most wanted'));

  const body = h('div', { class: 'item-body' },
    h('span', { class: 'item-src', text: i.source || '' }),
    h('h3', { class: 'item-title' }, h('a', { href: i.url, target: '_blank', rel: 'noopener noreferrer', tabindex: '-1', text: i.title })),
    i.notes && variant !== 'compact' ? h('p', { class: 'item-notes', text: i.notes }) : null,
    h('div', { class: 'item-foot' },
      i.price != null ? h('span', { class: 'price', text: fmtPrice(i.price, i.currency) }) : h('span', { class: 'price na', text: 'See store' }),
      actionFor(i, isMine)));

  return h('article', { class: 'item reveal' + (variant ? ' ' + variant : '') + (i.reserved ? ' taken' : ''), 'data-id': i.id, style: { '--h': hueOf(i.category) } }, tile, body);
}

function ideaCard(i) {
  const isMine = i.reserved && !!mine()[i.id];
  return h('article', { class: 'idea reveal' + (i.reserved ? ' taken' : ''), 'data-id': i.id },
    h('div', { class: 'ic' }, icon('bulb', 18)),
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('h3', { text: i.title }),
      i.notes ? h('p', { text: i.notes }) : null,
      h('div', { class: 'item-foot' },
        i.price != null ? h('span', { class: 'price', text: fmtPrice(i.price, i.currency) }) : h('span'),
        actionFor(i, isMine))));
}

function actionFor(i, isMine) {
  if (isMine) return h('button', { class: 'btn ghost sm', type: 'button', onclick: () => askUndo(i) }, icon('undo', 14), 'Undo');
  if (i.reserved) return h('span', { class: 'chip' }, 'Taken');
  return h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Reserve ' + i.title, onclick: (e) => askReserve(i, e.currentTarget) }, 'Reserve');
}

/* ───── Reserve flow ───── */
let pending = null, pendingBtn = null;
function askReserve(i, btn) {
  pending = i; pendingBtn = btn;
  const tImg = i.image ? h('img', { src: i.image, alt: '' }) : null;
  if (tImg && i.imageDirect) tImg.addEventListener('error', () => { if (tImg.src !== i.imageDirect) { tImg.referrerPolicy = 'no-referrer'; tImg.src = i.imageDirect; } }, { once: true });
  const thumb = h('div', { class: 'thumb' }, tImg || icon('gift', 22));
  $('#reserveItem').replaceChildren(thumb, h('div', { style: { minWidth: '0' } }, h('b', { text: i.title }), h('span', { text: [i.price != null ? fmtPrice(i.price, i.currency) : null, i.source].filter(Boolean).join(' · ') })));
  $('#rName').value = store.get('giftos_name', '');
  openDialog($('#reserveDlg'));
}

$('#reserveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pending) return;
  const btn = $('#reserveGo'); const name = $('#rName').value.trim();
  busy(btn, true);
  try {
    const { token, item } = await api(`/api/items/${pending.id}/reserve`, { method: 'POST', body: { name } });
    setMine(item.id, token);
    if (name) store.set('giftos_name', name);
    closeDialog($('#reserveDlg'));
    const from = pendingBtn && document.contains(pendingBtn) ? pendingBtn.getBoundingClientRect() : null;
    replaceItem(item);
    confetti(from);
    toast('Reserved. You’re getting this one!', 'ok');
  } catch (err) {
    toast(err.message, 'err');
    if (err.status === 409 || err.status === 404) { closeDialog($('#reserveDlg')); load(true); }
  } finally { busy(btn, false); }
});

let undoing = null;
function askUndo(i) { undoing = i; openDialog($('#undoDlg')); }
$('#undoGo').addEventListener('click', async () => {
  if (!undoing) return;
  const btn = $('#undoGo'); busy(btn, true);
  try {
    const { item } = await api(`/api/items/${undoing.id}/reserve`, { method: 'DELETE', body: { token: mine()[undoing.id] } });
    setMine(item.id, null); replaceItem(item);
    closeDialog($('#undoDlg')); toast('Released. It’s back on the list.');
  } catch (err) { toast(err.message, 'err'); }
  finally { busy(btn, false); }
});

function replaceItem(item) {
  const idx = S.items.findIndex((x) => x.id === item.id);
  if (idx > -1) S.items[idx] = item;
  const y = scrollY;
  renderHero(); renderSections();
  $$('.reveal').forEach((e) => e.classList.add('in'));
  scrollTo({ top: y });
}

/* ───── Surprise me ───── */
function surpriseMe() {
  const cards = $$('#shelf .item:not(.taken)');
  const pool = cards.length ? cards : $$('.item:not(.taken)');
  if (!pool.length) { toast('Everything’s been reserved. Nice!'); return; }
  const el = pool[Math.floor(Math.random() * pool.length)];
  el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
  el.classList.remove('pick'); void el.offsetWidth; el.classList.add('pick');
}

/* ───── Confetti ───── */
function confetti(rect) {
  if (reduceMotion()) return;
  const cx = rect ? rect.left + rect.width / 2 : innerWidth / 2, cy = rect ? rect.top + rect.height / 2 : innerHeight / 2;
  const colors = [getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0a6cff', '#ffb020', '#ff5f8f', '#18a058', '#7c5cff'];
  for (let n = 0; n < 34; n++) {
    const p = h('span', { class: 'confetti', style: { left: cx + 'px', top: cy + 'px', background: colors[n % colors.length] } });
    document.body.append(p);
    const a = (Math.PI * 2 * n) / 34 + Math.random() * .4, v = 90 + Math.random() * 130;
    const dx = Math.cos(a) * v, dy = Math.sin(a) * v - 80;
    p.animate([
      { transform: 'translate(-50%,-50%) rotate(0deg) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 160}px)) rotate(${Math.random() * 720 - 360}deg) scale(.6)`, opacity: 0 },
    ], { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.22,1,.36,1)' }).onfinish = () => p.remove();
  }
}

/* ───── Search ───── */
function openSearch() {
  $('#jumpPills').hidden = true; $('#searchBox').hidden = false;
  const top = $('#jump').getBoundingClientRect().top + scrollY - 62;
  if (scrollY < top) scrollTo({ top, behavior: reduceMotion() ? 'auto' : 'smooth' });
  setTimeout(() => $('#search').focus(), 50);
}
function closeSearch() {
  $('#search').value = ''; S.query = '';
  $('#searchBox').hidden = true; $('#jumpPills').hidden = false;
  renderSections();
}
$('#searchOpen').addEventListener('click', openSearch);
$('#searchClose').addEventListener('click', closeSearch);
$('#search').addEventListener('input', (e) => { S.query = e.target.value; renderSections(); });
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
document.addEventListener('keydown', (e) => {
  if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
});
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('#kbdHint').textContent = '⌘K';

/* ───── Scroll spy for the section pills ───── */
let spyIO;
function spy() {
  spyIO?.disconnect();
  const pills = $$('#jumpPills .pill');
  if (!pills.length) return;
  const setOn = (id) => pills.forEach((p) => {
    const on = p.dataset.target === id;
    if (on && !p.classList.contains('on')) p.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    p.classList.toggle('on', on);
  });
  spyIO = new IntersectionObserver((entries) => {
    const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) setOn(vis.target.id);
  }, { rootMargin: '-130px 0px -60% 0px' });
  $$('#sections .section').forEach((s) => spyIO.observe(s));
}

/* ───── Boot ───── */
$('#navRight').append(themeToggle());
wireTheme();
wireDialogs();
const nav = $('#nav');
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 4), { passive: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.loaded) load(true); });
reveal();
$('#budgetOk').addEventListener('click', () => closeDialog($('#budgetDlg')));
// However it's closed (button, Esc, tapping outside), don't show it again on this device.
$('#budgetDlg').addEventListener('close', () => store.set(budgetSeenKey, true));
load();
