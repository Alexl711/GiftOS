/**
 * Gift OS — Cloudflare Worker
 *
 * Public site  (/)        : the wishlist people see when you share the link.
 * Admin        (/admin)   : where the owner pastes links; items are read in the background.
 *
 * Public API
 *   GET    /api/list                  settings + ready items (no reserver names)
 *   POST   /api/items/:id/reserve     { name } -> { token }
 *   DELETE /api/items/:id/reserve     { token }
 *   GET    /api/img/:id               cached product photo
 * Owner API (session cookie)
 *   POST   /api/login | /api/logout
 *   GET    /api/admin/state
 *   POST   /api/admin/links           { text } -> creates "pending" items, reads them in the background
 *   POST   /api/admin/items           manual item / idea
 *   PATCH  /api/admin/items/:id       edit
 *   DELETE /api/admin/items/:id       remove
 *   POST   /api/admin/items/:id/refresh   re-read price + photo in the background
 *   DELETE /api/admin/items/:id/reserve   release a reservation
 *   PUT    /api/admin/settings
 */
import { scrape, isHttp, hostOf, UA, tidyTitle, guessCategory, parsePrice, type Scraped } from './scrape';
import { STATIC } from './static.generated';

export interface Env {
  DB: D1Database;
  OWNER_PASSWORD: string;
}

type Row = {
  id: string; status: string; title: string; url: string | null; source: string | null; category: string;
  image: string | null; price: number | null; currency: string; notes: string | null; starred: number;
  created_at: number; updated_at: number; reserved_by: string | null; reserved_at: number | null;
  reserve_token_hash: string | null;
};

const SESSION_COOKIE = 'giftos_session';
const SESSION_DAYS = 30;
const MAX_LOGIN_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LINKS = 30;

export const ACCENTS: Record<string, string> = {
  blue: '#0a6cff', violet: '#7c5cff', pink: '#e0407b', red: '#e5484d', orange: '#f76b15', green: '#18a058',
};

const DEFAULT_SETTINGS: Record<string, string> = {
  name: 'Alex',
  title: 'Alex’s Wishlist',
  tagline: 'Things I’d love, all in one place.',
  message: 'Reserve something so nobody doubles up, then grab it from the store. Thank you!',
  event_name: '',
  event_date: '',
  accent: 'blue',
};
const SETTING_LIMITS: Record<string, number> = { name: 40, title: 80, tagline: 120, message: 400, event_name: 40, event_date: 10, accent: 12 };

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

/* ───────────────────────── Entry ───────────────────────── */

export default {
  // Every minute: finish any links still waiting to be read (e.g. a background job that ran out of time).
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(processPending(env, 6));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.hostname.startsWith('www.')) { url.hostname = url.hostname.slice(4); return Response.redirect(url.href, 301); }
    if (url.pathname === '/' || url.pathname === '/index.html') return renderIndex(env);
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, url);
    try {
      return await route(req, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong. Try again.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  // Mutations must be JSON: blocks cross-site form posts (CSRF), on top of SameSite=Strict cookies.
  if (m !== 'GET' && m !== 'HEAD' && !(req.headers.get('content-type') || '').includes('application/json')) {
    throw new HttpError(415, 'Expected JSON.');
  }

  /* ── public ── */
  if (p === '/api/list' && m === 'GET') {
    const { results } = await env.DB.prepare("SELECT * FROM items WHERE status != 'pending' OR url IS NULL ORDER BY created_at DESC").all<Row>();
    return json({ settings: await getSettings(env), items: results.map((r) => publicItem(r)) });
  }

  let mm = p.match(/^\/api\/items\/([\w-]{8,64})\/reserve$/);
  if (mm && m === 'POST') {
    const body = await readJson(req);
    const name = clean(body.name, 60) || 'Someone';
    const token = crypto.randomUUID();
    const res = await env.DB.prepare(
      'UPDATE items SET reserved_by=?, reserved_at=?, reserve_token_hash=? WHERE id=? AND reserved_at IS NULL',
    ).bind(name, Date.now(), await sha256(token), mm[1]).run();
    if (!res.meta.changes) {
      throw (await getRow(env, mm[1])) ? new HttpError(409, 'Someone just reserved this one.') : new HttpError(404, 'That item is no longer on the list.');
    }
    return json({ token, item: publicItem((await getRow(env, mm[1]))!) });
  }
  if (mm && m === 'DELETE') {
    const row = await getRow(env, mm[1]);
    if (!row) throw new HttpError(404, 'That item is no longer on the list.');
    const { token } = await readJson(req);
    if (!token || !row.reserve_token_hash || (await sha256(String(token))) !== row.reserve_token_hash) {
      throw new HttpError(403, 'Only the person who reserved this can release it.');
    }
    await release(env, row.id);
    return json({ item: publicItem((await getRow(env, row.id))!) });
  }

  mm = p.match(/^\/api\/img\/([\w-]{8,64})$/);
  if (mm && m === 'GET') return proxyImage(env, mm[1]);

  /* ── auth ── */
  if (p === '/api/login' && m === 'POST') return login(req, env);
  if (p === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });

  /* ── owner ── */
  if (p.startsWith('/api/admin/')) {
    if (!(await isOwner(req, env))) throw new HttpError(401, 'Please sign in.');

    if (p === '/api/admin/state' && m === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM items ORDER BY created_at DESC').all<Row>();
      return json({ settings: await getSettings(env), items: results.map(ownerItem), accents: ACCENTS });
    }

    if (p === '/api/admin/links' && m === 'POST') {
      const body = await readJson(req);
      const found: string[] = String(body.text || '').match(/https?:\/\/[^\s"'<>]+/g) || [];
      const urls = [...new Set(found.map((u) => u.replace(/[),.;]+$/, '')))].filter(isHttp);
      if (!urls.length) throw new HttpError(400, 'No links found. Paste a full link starting with https://');
      if (urls.length > MAX_LINKS) throw new HttpError(400, `That’s ${urls.length} links. Paste up to ${MAX_LINKS} at a time.`);

      const existing = new Set((await env.DB.prepare('SELECT url FROM items WHERE url IS NOT NULL').all<{ url: string }>())
        .results.map((r) => dedupeKey(r.url)));
      const fresh = urls.filter((u) => !existing.has(dedupeKey(u)));
      const now = Date.now();
      const rows = fresh.map((u, i) => ({ id: crypto.randomUUID(), url: u, created: now + i }));
      if (rows.length) {
        await env.DB.batch(rows.map((r) => env.DB.prepare(
          `INSERT INTO items (id, status, title, url, source, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?, ?, ?)`,
        ).bind(r.id, hostOf(r.url), r.url, hostOf(r.url), r.created, r.created)));
        // Read the first few right after responding (Cloudflare allows ~30s of background work);
        // the per-minute job picks up the rest. The admin page polls for results.
        ctx.waitUntil(Promise.allSettled(rows.slice(0, 3).map((r) => readLink(env, r.id, r.url, 'new'))));
      }
      const created = await Promise.all(rows.map((r) => getRow(env, r.id)));
      return json({ items: created.filter(Boolean).map((r) => ownerItem(r!)), skipped: urls.length - fresh.length }, 202);
    }

    // From the "Add to wishlist" bookmark: details read in the owner's own browser on the store page.
    if (p === '/api/admin/clip' && m === 'POST') {
      const b = await readJson(req);
      const link = String(b.url || '').trim();
      if (!isHttp(link)) throw new HttpError(400, 'That page has no link to save.');
      const dupe = (await env.DB.prepare('SELECT id, url FROM items WHERE url IS NOT NULL').all<{ id: string; url: string }>())
        .results.find((r) => dedupeKey(r.url) === dedupeKey(link));
      if (dupe) {
        // Already on the list: fill in a missing photo or price, never overwrite what's there.
        const img = isHttp(String(b.image || '').trim()) ? String(b.image).trim().slice(0, 2000) : null;
        const pr = parsePrice(b.price) ?? null;
        await env.DB.prepare(`UPDATE items SET image=COALESCE(image, ?), price=COALESCE(price, ?), status='ready', updated_at=? WHERE id=?`)
          .bind(img, pr, Date.now(), dupe.id).run();
        return json({ item: ownerItem((await getRow(env, dupe.id))!), updated: true });
      }
      const title = tidyTitle(String(b.title || '')) || hostOf(link);
      const f = sanitize({ title, url: link, image: b.image, price: parsePrice(b.price) ?? '', currency: b.currency, category: guessCategory(`${title} ${link}`) });
      const complete = !!(f.image && f.price != null);
      const id = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO items (id, status, title, url, source, category, image, price, currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, complete ? 'ready' : 'pending', f.title, f.url, f.source, f.category, f.image, f.price, f.currency, now, now).run();
      if (!complete) ctx.waitUntil(readLink(env, id, link, 'fill'));
      return json({ item: ownerItem((await getRow(env, id))!) }, 201);
    }

    if (p === '/api/admin/items' && m === 'POST') {
      const f = sanitize(await readJson(req));
      if (!f.title) throw new HttpError(400, 'Give it a title.');
      const id = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO items (id, status, title, url, source, category, image, price, currency, notes, starred, created_at, updated_at)
         VALUES (?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, f.title, f.url, f.source, f.category, f.image, f.price, f.currency, f.notes, f.starred, now, now).run();
      return json({ item: ownerItem((await getRow(env, id))!) }, 201);
    }

    mm = p.match(/^\/api\/admin\/items\/([\w-]{8,64})(\/refresh|\/reserve)?$/);
    if (mm) {
      const [, id, sub] = mm;
      const row = await getRow(env, id);
      if (!row) throw new HttpError(404, 'That item no longer exists.');

      if (!sub && m === 'PATCH') {
        const body = await readJson(req);
        const f = sanitize({ ...ownerItem(row), image: row.image, ...body });
        if (!f.title) throw new HttpError(400, 'Title can’t be empty.');
        await env.DB.prepare(
          `UPDATE items SET title=?, url=?, source=?, category=?, image=?, price=?, currency=?, notes=?, starred=?, updated_at=? WHERE id=?`,
        ).bind(f.title, f.url, f.source, f.category, f.image, f.price, f.currency, f.notes, f.starred, Date.now(), id).run();
        return json({ item: ownerItem((await getRow(env, id))!) });
      }
      if (!sub && m === 'DELETE') {
        await env.DB.prepare('DELETE FROM items WHERE id=?').bind(id).run();
        return json({ ok: true });
      }
      if (sub === '/refresh' && m === 'POST') {
        if (!row.url) throw new HttpError(400, 'This item has no link to read.');
        await env.DB.prepare("UPDATE items SET status='pending', updated_at=? WHERE id=?").bind(Date.now(), id).run();
        ctx.waitUntil(readLink(env, id, row.url, 'refresh'));
        return json({ item: ownerItem((await getRow(env, id))!) }, 202);
      }
      if (sub === '/reserve' && m === 'DELETE') {
        await release(env, id);
        return json({ item: ownerItem((await getRow(env, id))!) });
      }
    }

    if (p === '/api/admin/settings' && m === 'PUT') {
      const body = await readJson(req);
      const stmts = Object.keys(DEFAULT_SETTINGS).filter((k) => typeof body[k] === 'string').map((k) => {
        let v = String(body[k]).trim().slice(0, SETTING_LIMITS[k]);
        if (k === 'accent' && !(v in ACCENTS)) v = 'blue';
        if (k === 'event_date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = '';
        return env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, v);
      });
      if (stmts.length) await env.DB.batch(stmts);
      return json({ settings: await getSettings(env) });
    }
  }

  throw new HttpError(404, 'Not found.');
}

/* ───────────────────────── Background link reading ───────────────────────── */

/** Claims pending items that nobody is working on (untouched for 45s) and reads them, two at a time. */
async function processPending(env: Env, limit: number) {
  const cutoff = Date.now() - 45_000;
  const { results } = await env.DB.prepare(
    "SELECT id, url, title, source, updated_at FROM items WHERE status='pending' AND url IS NOT NULL AND updated_at < ? ORDER BY created_at LIMIT ?",
  ).bind(cutoff, limit).all<{ id: string; url: string; title: string; source: string; updated_at: number }>();
  const claimed = [];
  for (const r of results) {
    const res = await env.DB.prepare('UPDATE items SET updated_at=? WHERE id=? AND updated_at=?').bind(Date.now(), r.id, r.updated_at).run();
    if (res.meta.changes) claimed.push(r);
  }
  for (let i = 0; i < claimed.length; i += 2) {
    await Promise.allSettled(claimed.slice(i, i + 2).map((r) => readLink(env, r.id, r.url, r.title === r.source ? 'new' : 'fill')));
  }
}

async function readLink(env: Env, id: string, url: string, mode: 'new' | 'refresh' | 'fill') {
  let s: Scraped;
  try {
    s = await scrape(url);
  } catch (e) {
    console.error('scrape failed', url, e);
    await env.DB.prepare("UPDATE items SET status='failed', updated_at=? WHERE id=?").bind(Date.now(), id).run();
    return;
  }
  const status = s.found.image || s.found.price || s.found.title ? 'ready' : 'failed';
  if (mode === 'new') {
    await env.DB.prepare(
      `UPDATE items SET status=?, title=?, source=?, category=?, image=?, price=?, currency=?, updated_at=? WHERE id=? AND status='pending'`,
    ).bind(status, s.title, s.source, s.category, s.image, s.price, s.currency, Date.now(), id).run();
  } else if (mode === 'fill') {
    // Only fill in what the bookmark couldn't find; never overwrite it.
    await env.DB.prepare(
      `UPDATE items SET status='ready', image=COALESCE(image, ?), price=COALESCE(price, ?), updated_at=? WHERE id=?`,
    ).bind(s.image, s.price, Date.now(), id).run();
  } else {
    // Refresh keeps the owner's edits; only fills in a newer price/photo when one was found.
    await env.DB.prepare(
      `UPDATE items SET status='ready', image=COALESCE(?, image), price=COALESCE(?, price), currency=CASE WHEN ? IS NULL THEN currency ELSE ? END, updated_at=? WHERE id=?`,
    ).bind(s.image, s.price, s.price, s.currency, Date.now(), id).run();
  }
}

/* ───────────────────────── Index page ───────────────────────── */

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

function serveStatic(req: Request, url: URL): Response {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const hit = STATIC[path];
  if (!hit) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  if (path === '/admin.html') return Response.redirect(new URL('/admin', url).href, 301);
  const etag = '"' + hash(hit[0]) + '"';
  const headers = { 'content-type': hit[1], etag, 'cache-control': hit[1].startsWith('text/html') ? 'no-cache' : 'public, max-age=300, must-revalidate', ...SECURITY_HEADERS };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(req.method === 'HEAD' ? null : hit[0], { headers });
}

async function renderIndex(env: Env): Promise<Response> {
  const page = new Response(STATIC['/'][0], { headers: { 'content-type': STATIC['/'][1], 'cache-control': 'no-cache', ...SECURITY_HEADERS } });
  let s = DEFAULT_SETTINGS;
  try { s = await getSettings(env); } catch { /* DB not migrated yet */ }
  const accent = ACCENTS[s.accent] || ACCENTS.blue;
  return new HTMLRewriter()
    .on('html', { element: (e) => { e.setAttribute('style', `--accent:${accent}`); } })
    .on('title', { element: (e) => { e.setInnerContent(s.title); } })
    .on('meta[property="og:title"]', { element: (e) => { e.setAttribute('content', s.title); } })
    .on('meta[property="og:description"], meta[name="description"]', { element: (e) => { e.setAttribute('content', s.tagline); } })
    .transform(page);
}

/* ───────────────────────── Data ───────────────────────── */

async function getSettings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of results) if (r.key in out) out[r.key] = r.value;
  return out;
}

const getRow = (env: Env, id: string) => env.DB.prepare('SELECT * FROM items WHERE id=?').bind(id).first<Row>();
const release = (env: Env, id: string) =>
  env.DB.prepare('UPDATE items SET reserved_by=NULL, reserved_at=NULL, reserve_token_hash=NULL WHERE id=?').bind(id).run();

const imgPath = (r: Row) => (r.image ? `/api/img/${r.id}?v=${hash(r.image)}` : null);

/** What visitors see. Who reserved something is never sent to the public. */
function publicItem(r: Row) {
  return {
    id: r.id, title: r.title, url: r.url, source: r.source, category: r.category, image: imgPath(r), imageDirect: r.image,
    price: r.price, currency: r.currency, notes: r.notes, starred: !!r.starred, createdAt: r.created_at,
    reserved: r.reserved_at != null,
  };
}

function ownerItem(r: Row) {
  return { ...publicItem(r), status: r.status, rawImage: r.image, reservedBy: r.reserved_by, reservedAt: r.reserved_at, updatedAt: r.updated_at };
}

type Fields = {
  title: string; url: string | null; source: string | null; category: string; image: string | null;
  price: number | null; currency: string; notes: string | null; starred: number;
};

function sanitize(b: Record<string, unknown>): Fields {
  const url = isHttp(String(b.url || '').trim()) ? String(b.url).trim().slice(0, 2000) : null;
  const image = isHttp(String(b.image || '').trim()) ? String(b.image).trim().slice(0, 2000) : null;
  const priceNum = b.price === '' || b.price == null ? NaN : Number(b.price);
  const cur = String(b.currency || 'USD').trim().toUpperCase();
  return {
    title: clean(b.title, 200),
    url,
    source: url ? hostOf(url) : null,
    category: clean(b.category, 40) || 'Other',
    image,
    price: Number.isFinite(priceNum) && priceNum >= 0 ? Math.round(priceNum * 100) / 100 : null,
    currency: /^[A-Z]{3}$/.test(cur) ? cur : 'USD',
    notes: clean(b.notes, 500) || null,
    starred: b.starred ? 1 : 0,
  };
}

/* ───────────────────────── Auth ───────────────────────── */

async function login(req: Request, env: Env): Promise<Response> {
  if (!env.OWNER_PASSWORD) throw new HttpError(500, 'The owner password isn’t set up on the server yet.');
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const since = Date.now() - LOGIN_WINDOW_MS;
  const fails = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip=? AND ts>?').bind(ip, since).first<number>('n');
  if ((fails || 0) >= MAX_LOGIN_FAILS) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.');

  const { password } = await readJson(req);
  if (!(await safeEqual(String(password || ''), env.OWNER_PASSWORD))) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_attempts (ip, ts) VALUES (?, ?)').bind(ip, Date.now()),
      env.DB.prepare('DELETE FROM login_attempts WHERE ts<?').bind(since),
    ]);
    throw new HttpError(401, 'Wrong password.');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip=?').bind(ip).run();
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return json({ ok: true }, 200, { 'set-cookie': cookie(`${exp}.${await sign(env, String(exp))}`, SESSION_DAYS * 86400) });
}

const cookie = (value: string, maxAge: number) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function isOwner(req: Request, env: Env): Promise<boolean> {
  if (!env.OWNER_PASSWORD) return false;
  const m = (req.headers.get('cookie') || '').match(new RegExp(`${SESSION_COOKIE}=(\\d+)\\.([\\w-]+)`));
  if (!m || Number(m[1]) < Date.now()) return false;
  return safeEqual(m[2], await sign(env, m[1]));
}

async function sign(env: Env, data: string): Promise<string> {
  // Keyed on the password, so changing OWNER_PASSWORD signs every session out.
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('giftos-session:' + env.OWNER_PASSWORD),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ───────────────────────── Image proxy ───────────────────────── */

async function proxyImage(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT image, url FROM items WHERE id=?').bind(id).first<{ image: string | null; url: string | null }>();
  if (!row?.image) return new Response('Not found', { status: 404 });
  try {
    const r = await fetch(row.image, {
      headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/*,*/*;q=0.8', ...(row.url ? { referer: row.url } : {}) },
      cf: { cacheTtl: 86400 * 7, cacheEverything: true },
      signal: AbortSignal.timeout(10000),
    });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/') || type.includes('svg')) return new Response('Bad image', { status: 502 });
    return new Response(r.body, {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=604800, immutable', 'x-content-type-options': 'nosniff' },
    });
  } catch {
    return new Response('Image unavailable', { status: 502 });
  }
}

/* ───────────────────────── Helpers ───────────────────────── */

async function readJson(req: Request): Promise<Record<string, any>> {
  try { const b = await req.json(); return b && typeof b === 'object' ? (b as Record<string, any>) : {}; }
  catch { return {}; }
}

const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function dedupeKey(url: string): string {
  try { const u = new URL(url); return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/+$/, '').toLowerCase(); }
  catch { return url; }
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
