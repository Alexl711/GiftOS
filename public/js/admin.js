'use strict';
/* Owner admin: paste links (read in the background), manage items, edit the page. */

const A = { items: [], settings: {}, accents: {}, filter: 'all', surprise: store.get('giftos_surprise', false), seen: new Set() };
let pollTimer = null;

/* ───── Boot / auth ───── */
async function boot() {
  try {
    await refresh();
    showApp();
    handleClip();
  } catch (e) {
    if (e.status === 401) showLogin(); else { showLogin(); toast(e.message, 'err'); }
  }
}

function showLogin() { $('#app').hidden = true; $('#login').hidden = false; setTimeout(() => $('#pw').focus(), 50); }
function showApp() { $('#login').hidden = true; $('#app').hidden = false; reveal(); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginGo'); busy(btn, true);
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
    $('#pw').value = '';
    await refresh(); showApp(); handleClip();
  } catch (err) {
    const card = $('#loginForm'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    toast(err.message, 'err'); $('#pw').select();
  } finally { busy(btn, false); }
});

async function signOut() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* already out */ }
  stopPolling(); showLogin(); toast('Signed out');
}

/* ───── Data ───── */
async function refresh() {
  const d = await api('/api/admin/state');
  const before = new Map(A.items.map((i) => [i.id, i.status]));
  A.items = d.items; A.settings = d.settings; A.accents = d.accents;
  applyAccent(A.settings.accent);
  renderStats(); renderRows(before); fillSettings();
  if (A.items.some((i) => i.status === 'pending')) startPolling(); else stopPolling();
}

function startPolling() {
  if (pollTimer) return;
  let n = 0;
  pollTimer = setInterval(async () => {
    if (++n > 90) return stopPolling();
    try { await refresh(); } catch (e) { if (e.status === 401) { stopPolling(); showLogin(); } }
  }, 1500);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

const needsLook = (i) => i.status === 'failed' || (i.url && i.status === 'ready' && (i.price == null || !i.image));

/* ───── Stats ───── */
function renderStats() {
  const ready = A.items.filter((i) => i.status !== 'pending');
  countTo($('#stItems'), A.items.length, Math.round);
  countTo($('#stReserved'), A.items.filter((i) => i.reserved).length, Math.round);
  countTo($('#stValue'), ready.reduce((s, i) => s + (i.price || 0), 0), (v) => '$' + Math.round(v).toLocaleString());
  const attn = A.items.filter(needsLook).length;
  countTo($('#stAttn'), attn, Math.round);
  $('#stAttn').parentElement.classList.toggle('attn', attn > 0);
  $('#stReserved').parentElement.hidden = A.surprise;
  $('.tiles').style.gridTemplateColumns = A.surprise && innerWidth > 640 ? 'repeat(3,minmax(0,1fr))' : '';
}

/* ───── Rows ───── */
function renderRows(before = new Map()) {
  let list = A.items;
  if (A.filter === 'attn') list = list.filter(needsLook);
  if (A.filter === 'reserved') list = list.filter((i) => i.reserved);
  const rows = $('#rows');
  if (!list.length) {
    rows.replaceChildren(h('div', { class: 'rows-empty' },
      h('b', { text: A.filter === 'all' ? 'Nothing here yet' : A.filter === 'attn' ? 'All good' : 'No reservations yet' }),
      A.filter === 'all' ? 'Paste a product link above to add your first item.' : A.filter === 'attn' ? 'Every item has a photo and a price.' : 'When someone reserves a gift, it shows up here.'));
    return;
  }
  rows.replaceChildren(...list.map((i) => {
    const el = row(i);
    if (!A.seen.has(i.id)) { if (A.seen.size) el.classList.add('enter'); A.seen.add(i.id); }
    else if (before.get(i.id) === 'pending' && i.status !== 'pending') el.classList.add('done');
    return el;
  }));
}

function row(i) {
  const pendingNow = i.status === 'pending';
  const thumb = h('div', { class: 'thumb' + (pendingNow ? ' loading' : '') + (!i.url ? ' idea' : '') });
  if (!pendingNow) {
    if (i.image) {
      const img = h('img', { src: i.image, alt: '' });
      img.addEventListener('error', function onErr() {
        if (i.rawImage && img.src !== i.rawImage) { img.referrerPolicy = 'no-referrer'; img.src = i.rawImage; return; }
        img.removeEventListener('error', onErr); img.replaceWith(icon('gift', 22));
      });
      thumb.append(img);
    }
    else thumb.append(icon(i.url ? 'gift' : 'bulb', 22));
  }

  const meta = h('div', { class: 'r-meta' });
  if (pendingNow) {
    meta.append(h('span', { class: 'steps' },
      h('span', { class: 'step now' }, h('span', { class: 'spinner' }), 'Reading page'),
      h('span', { class: 'step', style: { animationDelay: '.15s' } }, 'Photo'),
      h('span', { class: 'step', style: { animationDelay: '.3s' } }, 'Price')));
  } else {
    if (i.source) meta.append(h('span', { class: 'src', text: i.source }));
    else meta.append(h('span', { class: 'chip accent', text: 'Idea' }));
    meta.append(h('span', { class: 'chip', text: i.category }));
    if (i.status === 'failed') meta.append(h('span', { class: 'chip warn' }, h('span', { class: 'dot' }), 'Couldn’t read page'));
    else if (i.url && !i.image) meta.append(h('span', { class: 'chip warn' }, h('span', { class: 'dot' }), 'No photo'));
    if (i.reserved && !A.surprise) meta.append(h('span', { class: 'chip ok' }, icon('check', 12, 'stroke-width="2.6"'), i.reservedBy ? 'Reserved by ' + i.reservedBy : 'Reserved'));
  }

  const title = h('div', { class: 'r-title', text: pendingNow ? (i.url || i.title) : i.title, onclick: () => !pendingNow && openEdit(i) });
  const price = pendingNow ? h('span', { class: 'r-price' }, h('span', { class: 'skel', style: { display: 'inline-block', width: '48px', height: '16px', borderRadius: '6px' } }))
    : i.price != null ? h('span', { class: 'r-price', text: fmtPrice(i.price, i.currency) })
    : i.url ? h('span', { class: 'r-price na', text: 'Add price', role: 'button', tabindex: '0', onclick: () => openEdit(i, 'ePrice') })
    : h('span', { class: 'r-price' });

  const star = h('button', { class: 'star-btn' + (i.starred ? ' on' : ''), type: 'button', disabled: pendingNow, 'aria-pressed': String(i.starred),
    'aria-label': 'Most wanted', title: i.starred ? 'Most wanted' : 'Mark as most wanted', onclick: (e) => toggleStar(i, e.currentTarget) }, icon('star', 17));
  const more = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'More for ' + i.title, disabled: pendingNow, onclick: (e) => rowMenu(i, e.currentTarget) }, icon('more'));

  return h('div', { class: 'r', 'data-id': i.id }, thumb, h('div', { class: 'r-main' }, title, meta), price, h('div', { class: 'r-act' }, star, more));
}

function rowMenu(i, anchor) {
  const items = [{ icon: 'pencil', label: 'Edit details', run: () => openEdit(i) }];
  if (i.url) {
    items.push({ icon: 'refresh', label: 'Refresh price & photo', run: () => refreshItem(i) });
    items.push({ icon: 'arrowOut', label: 'Open store page', run: () => open(i.url, '_blank', 'noopener') });
  }
  if (i.reserved && !A.surprise) items.push({ icon: 'undo', label: 'Release reservation', run: () => confirmThen('Release this reservation?', `“${i.title}” goes back on the list. ${i.reservedBy || 'The gift-giver'} won’t be notified.`, 'Release', () => release(i)) });
  items.push('-', { icon: 'trash', label: 'Remove', danger: true, run: () => confirmThen('Remove this item?', `“${i.title}” will be taken off your list.`, 'Remove', () => removeItem(i)) });
  showMenu(anchor, items);
}

/* ───── Add links ───── */
const linksEl = $('#links');
const findLinks = (t) => [...new Set(t.match(/https?:\/\/[^\s"'<>]+/g) || [])];
function autoGrow() { linksEl.style.height = 'auto'; linksEl.style.height = Math.min(linksEl.scrollHeight, 220) + 'px'; }
linksEl.addEventListener('input', () => {
  autoGrow();
  const n = findLinks(linksEl.value).length;
  $('#sendBtn').disabled = n === 0;
  $('#linkHint').textContent = n > 1 ? `${n} links ready` : n === 1 ? 'Press Enter to add' : '';
});
linksEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!$('#sendBtn').disabled) $('#linkForm').requestSubmit(); }
});
$('#linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#sendBtn'); busy(btn, true);
  try {
    const r = await api('/api/admin/links', { method: 'POST', body: { text: linksEl.value } });
    linksEl.value = ''; autoGrow(); $('#linkHint').textContent = '';
    if (A.filter !== 'all') { A.filter = 'all'; setFilter('all'); }
    await refresh();
    const n = r.items.length;
    toast(n ? `Adding ${n} item${n > 1 ? 's' : ''}. This takes a few seconds` + (r.skipped ? ` · ${r.skipped} already on your list` : '') : 'Already on your list', n ? 'ok' : undefined);
  } catch (err) { toast(err.message, 'err'); }
  finally { busy(btn, false); $('#sendBtn').disabled = !findLinks(linksEl.value).length; }
});

/* ───── Item actions ───── */
function patchLocal(item) { const k = A.items.findIndex((x) => x.id === item.id); if (k > -1) A.items[k] = item; else A.items.unshift(item); renderStats(); renderRows(); }

async function toggleStar(i, btn) {
  btn.classList.toggle('on'); btn.classList.remove('pop'); void btn.offsetWidth; if (!i.starred) btn.classList.add('pop');
  try { const { item } = await api('/api/admin/items/' + i.id, { method: 'PATCH', body: { starred: !i.starred } }); patchLocal(item); }
  catch (err) { btn.classList.toggle('on'); toast(err.message, 'err'); }
}

async function refreshItem(i) {
  try { const { item } = await api(`/api/admin/items/${i.id}/refresh`, { method: 'POST' }); patchLocal(item); startPolling(); toast('Checking the store for the latest price…'); }
  catch (err) { toast(err.message, 'err'); }
}

async function release(i) {
  const { item } = await api(`/api/admin/items/${i.id}/reserve`, { method: 'DELETE' });
  patchLocal(item); toast('Reservation released', 'ok');
}

async function removeItem(i) {
  await api('/api/admin/items/' + i.id, { method: 'DELETE' });
  const el = $(`.r[data-id="${i.id}"]`);
  const finish = () => { A.items = A.items.filter((x) => x.id !== i.id); renderStats(); renderRows(); };
  if (el && !reduceMotion()) { el.classList.add('leave'); setTimeout(finish, 280); } else finish();
  toast('Removed');
}

let confirmFn = null;
function confirmThen(title, text, label, fn) {
  $('#confirmH').textContent = title; $('#confirmText').textContent = text; $('#confirmGo').textContent = label;
  confirmFn = fn; openDialog($('#confirmDlg'));
}
$('#confirmGo').addEventListener('click', async () => {
  const btn = $('#confirmGo'); busy(btn, true);
  try { await confirmFn?.(); closeDialog($('#confirmDlg')); closeDialog($('#editDlg')); }
  catch (err) { toast(err.message, 'err'); }
  finally { busy(btn, false); }
});

/* ───── Edit / new idea ───── */
let editing = null;
function openEdit(i, focusId) {
  editing = i || null;
  $('#editH').textContent = i ? 'Edit item' : 'Add an idea';
  $('#eSave').textContent = i ? 'Save' : 'Add to list';
  $('#eDelete').hidden = !i;
  $('#eTitle').value = i?.title || '';
  $('#eUrl').value = i?.url || '';
  $('#eImage').value = i?.rawImage || '';
  $('#ePrice').value = i?.price ?? '';
  $('#eCurrency').value = i?.currency || 'USD';
  $('#eCategory').value = i?.category || (i ? '' : 'Ideas');
  $('#eNotes').value = i?.notes || '';
  $('#eStar').checked = !!i?.starred;
  $('#eTitle').placeholder = i ? '' : 'e.g., A gift card to REI, concert tickets…';
  $('#eImageField').hidden = !i?.url;
  const prev = $('#editPreview');
  if (i && i.url) {
    const t = h('div', { class: 'thumb' }, i.image ? h('img', { src: i.image, alt: '' }) : icon('gift', 24));
    prev.replaceChildren(t, h('div', { class: 'meta' }, h('div', { text: i.source || '' }),
      h('a', { href: i.url, target: '_blank', rel: 'noopener' }, 'Open store page', icon('arrowOut', 12))));
  } else prev.replaceChildren();
  const cats = [...new Set(A.items.map((x) => x.category))];
  $('#catList').replaceChildren(...cats.map((c) => h('option', { value: c })));
  openDialog($('#editDlg'));
  if (focusId) setTimeout(() => $('#' + focusId).focus(), 60);
}
$('#ideaBtn').addEventListener('click', () => openEdit(null));
$('#eDelete').addEventListener('click', () => editing && confirmThen('Remove this item?', `“${editing.title}” will be taken off your list.`, 'Remove', () => removeItem(editing)));
$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#eSave'); busy(btn, true);
  const body = {
    title: $('#eTitle').value, url: $('#eUrl').value, price: $('#ePrice').value, currency: $('#eCurrency').value,
    category: $('#eCategory').value, notes: $('#eNotes').value, starred: $('#eStar').checked,
  };
  if (editing?.url) body.image = $('#eImage').value || editing.rawImage || '';
  try {
    const { item } = editing
      ? await api('/api/admin/items/' + editing.id, { method: 'PATCH', body })
      : await api('/api/admin/items', { method: 'POST', body });
    patchLocal(item); closeDialog($('#editDlg')); toast(editing ? 'Saved' : 'Added to your list', 'ok');
  } catch (err) { toast(err.message, 'err'); }
  finally { busy(btn, false); }
});

/* ───── Settings ───── */
let settingsDirty = false;
function fillSettings() {
  if (settingsDirty) return;
  const s = A.settings;
  $('#sName').value = s.name || ''; $('#sTitle').value = s.title || ''; $('#sTagline').value = s.tagline || '';
  $('#sMessage').value = s.message || ''; $('#sEvent').value = s.event_name || ''; $('#sDate').value = s.event_date || '';
  $('#logoMark').textContent = (s.name || 'G').charAt(0).toUpperCase();
  const sw = $('#swatches');
  if (!sw.children.length) {
    sw.append(...Object.entries(A.accents).map(([k, c]) => h('button', { type: 'button', class: 'sw', role: 'radio', 'data-k': k, 'aria-label': k, title: k[0].toUpperCase() + k.slice(1), style: { '--c': c },
      onclick: () => { A.settings.accent = k; applyAccent(k); markSwatch(); settingsDirty = true; } })));
  }
  markSwatch();
}
const markSwatch = () => $$('#swatches .sw').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.k === A.settings.accent)));
function applyAccent(k) { const c = A.accents[k]; if (c) document.documentElement.style.setProperty('--accent', c); }
$('#settingsForm').addEventListener('input', () => { settingsDirty = true; });
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#saveSettings'); busy(btn, true);
  try {
    const { settings } = await api('/api/admin/settings', { method: 'PUT', body: {
      name: $('#sName').value, title: $('#sTitle').value, tagline: $('#sTagline').value, message: $('#sMessage').value,
      event_name: $('#sEvent').value, event_date: $('#sDate').value, accent: A.settings.accent || 'blue' } });
    A.settings = settings; settingsDirty = false; fillSettings(); toast('Your page is updated', 'ok');
  } catch (err) { toast(err.message, 'err'); }
  finally { busy(btn, false); }
});
$('#surprise').checked = A.surprise;
$('#surprise').addEventListener('change', (e) => {
  A.surprise = e.target.checked; store.set('giftos_surprise', A.surprise);
  if (A.surprise && A.filter === 'reserved') { A.filter = 'all'; setFilter('all'); }
  $('#filterSeg [data-v="reserved"]').hidden = A.surprise;
  renderStats(); renderRows();
  toast(A.surprise ? 'Surprise mode on. Reservations are hidden' : 'Surprise mode off');
});
$('#filterSeg [data-v="reserved"]').hidden = A.surprise;

/* ───── Share ───── */
$('#shareBtn').addEventListener('click', async () => {
  const url = location.origin + '/';
  try {
    if (navigator.share && matchMedia('(pointer:coarse)').matches) { await navigator.share({ title: A.settings.title, url }); return; }
    await navigator.clipboard.writeText(url); toast('Link copied. Send it to anyone', 'ok');
  } catch (err) { if (err?.name !== 'AbortError') toast(url); }
});
$('#moreBtn').addEventListener('click', (e) => showMenu(e.currentTarget, [
  { icon: 'eye', label: 'View your page', run: () => open('/', '_blank', 'noopener') },
  { icon: 'plus', label: 'Get the bookmark button', run: () => { $('#clipLink').href = bookmarkletCode(); openDialog($('#clipDlg')); } },
  { icon: 'refresh', label: 'Reload items', run: () => refresh().then(() => toast('Up to date')) },
  '-',
  { icon: 'lock', label: 'Sign out', run: signOut },
]));

/* ───── Bookmark button ("Add to wishlist") ─────
   Runs on the store page in the owner's browser, reads the product details that page already shows,
   and opens /admin with them. Nothing is sent anywhere else. */
function bookmarkletCode() {
  const src = `(function(){
    var q=function(s){return document.querySelector(s)};
    var m=function(n){var e=q('meta[property="'+n+'"],meta[name="'+n+'"],meta[itemprop="'+n+'"]');return e?e.getAttribute('content'):''};
    var d={url:(q('link[rel=canonical]')||{}).href||location.href.split('#')[0],title:m('og:title')||document.title,
      image:m('og:image')||m('twitter:image'),price:m('product:price:amount')||m('og:price:amount')||m('price'),
      currency:m('product:price:currency')||m('og:price:currency')||''};
    var find=function(o,k){if(!o||typeof o!=='object'||k>6)return null;if(Array.isArray(o)){for(var i=0;i<o.length;i++){var r=find(o[i],k+1);if(r)return r}return null}
      var t=o['@type'];if(t==='Product'||t==='ProductGroup'||(Array.isArray(t)&&t.indexOf('Product')>-1))return o;
      return find(o['@graph'],k+1)||find(o.mainEntity,k+1)};
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s){try{var p=find(JSON.parse(s.textContent),0);if(!p)return;
      if(p.name)d.title=p.name;var im=p.image;im=Array.isArray(im)?im[0]:im;im=im&&im.url||im;if(typeof im==='string'&&!d.image)d.image=im;
      var of=p.offers;of=Array.isArray(of)?of[0]:of;if(of&&!d.price){d.price=of.price||of.lowPrice||'';d.currency=of.priceCurrency||d.currency}}catch(e){}});
    var li=q('#landingImage');if(li&&!d.image)d.image=li.getAttribute('data-old-hires')||li.src;
    var ap=q('.a-price .a-offscreen,#corePrice_feature_div .a-offscreen');if(ap&&!d.price)d.price=ap.textContent;
    if(d.image)try{d.image=new URL(d.image,location.href).href}catch(e){}
    var to='${location.origin}/admin#clip='+encodeURIComponent(JSON.stringify(d));
    var w=window.open(to,'_blank');if(!w)location.href=to;
  })()`;
  return 'javascript:' + src.replace(/\n\s*/g, '');
}
$('#clipBtn').addEventListener('click', () => { $('#clipLink').href = bookmarkletCode(); openDialog($('#clipDlg')); });
$('#clipLink').addEventListener('click', (e) => { e.preventDefault(); toast('Drag it to your bookmarks bar instead of clicking'); });
$('#clipCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(bookmarkletCode()); toast('Copied. Paste it as the bookmark’s address', 'ok'); }
  catch { toast('Couldn’t copy. Long-press the button above and copy its link instead', 'err'); }
});

async function handleClip() {
  const m = location.hash.match(/^#clip=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  let data;
  try { data = JSON.parse(decodeURIComponent(m[1])); } catch { toast('That bookmark didn’t send anything readable', 'err'); return; }
  try {
    const { item, updated } = await api('/api/admin/clip', { method: 'POST', body: data });
    patchLocal(item); if (item.status === 'pending') startPolling();
    const name = item.title.length > 40 ? item.title.slice(0, 38) + '…' : item.title;
    toast(updated ? `Updated “${name}” with the store’s photo and price` : `Added “${name}”`, 'ok');
  } catch (err) { toast(err.message, err.status === 409 ? undefined : 'err'); }
}

/* ───── Filters, theme ───── */
const setFilter = segmented($('#filterSeg'), A.filter, (v) => { A.filter = v; renderRows(); });
$('#topActions').insertBefore(themeToggle(), $('#moreBtn'));
$$('#topActions .theme').forEach((t) => t.classList.add('hide-sm'));
wireTheme();
wireDialogs();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('#app').hidden) refresh().catch(() => {}); });
boot();
