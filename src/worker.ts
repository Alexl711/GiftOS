/**
 * Gift OS — Cloudflare Worker
 *
 * Public wishlist + password-protected owner mode, backed by D1.
 *   GET    /api/state                 settings + items (+ owner flag)
 *   POST   /api/login | /api/logout   owner session (HttpOnly cookie)
 *   PUT    /api/settings              owner: list title/headline/subtitle
 *   POST   /api/items                 owner: { url } scrapes, or { manual:true, ...fields }
 *   POST   /api/items/bulk            owner: { urls: [...] }
 *   PATCH  /api/items/:id             owner: edit fields
 *   DELETE /api/items/:id             owner: remove
 *   POST   /api/items/:id/reserve     anyone: { name } -> { token }
 *   DELETE /api/items/:id/reserve     reserver (with token) or owner
 *   GET    /api/img/:id               cached image proxy for an item's image
 */

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OWNER_PASSWORD: string;
}

type Row = {
  id: string; title: string; url: string | null; source: string | null; category: string;
  image: string | null; price: number | null; currency: string; notes: string | null;
  starred: number; created_at: number; reserved_by: string | null; reserved_at: number | null;
  reserve_token_hash: string | null;
};

const SESSION_COOKIE = 'giftos_session';
const SESSION_DAYS = 30;
const MAX_LOGIN_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const DEFAULT_SETTINGS: Record<string, string> = {
  title: 'My Wishlist',
  headline: 'Everything worth wanting.',
  subtitle: 'Pick something, hit Reserve so no one doubles up, and the link takes you straight to the store.',
};

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
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/' ) return renderIndex(req, env);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong. Try again.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  // Mutations must be JSON: blocks simple cross-site form posts (CSRF) on top of SameSite cookies.
  if (m !== 'GET' && m !== 'HEAD' && !(req.headers.get('content-type') || '').includes('application/json')) {
    throw new HttpError(415, 'Expected JSON.');
  }

  if (p === '/api/state' && m === 'GET') {
    const owner = await isOwner(req, env);
    return json({ owner, settings: await getSettings(env), items: await listItems(env, owner) });
  }
  if (p === '/api/login' && m === 'POST') return login(req, env);
  if (p === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });

  if (p === '/api/settings' && m === 'PUT') {
    await requireOwner(req, env);
    const body = await readJson(req);
    const stmts = Object.keys(DEFAULT_SETTINGS)
      .filter((k) => typeof body[k] === 'string')
      .map((k) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(k, String(body[k]).trim().slice(0, k === 'subtitle' ? 300 : 80)));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ settings: await getSettings(env) });
  }

  if (p === '/api/items' && m === 'POST') {
    await requireOwner(req, env);
    const body = await readJson(req);
    let fields: Fields;
    if (body.manual) {
      fields = sanitize(body);
      if (!fields.title) throw new HttpError(400, 'Give the item a title.');
    } else {
      const link = String(body.url || '').trim();
      if (!isHttp(link)) throw new HttpError(400, 'Paste a full link, starting with https://');
      fields = await scrape(link);
    }
    const item = await insertItem(env, fields);
    return json({ item: toItem(item, true) }, 201);
  }

  if (p === '/api/items/bulk' && m === 'POST') {
    await requireOwner(req, env);
    const body = await readJson(req);
    const raw: string[] = Array.isArray(body.urls) ? body.urls : String(body.text || '').match(/https?:\/\/[^\s"'<>]+/g) || [];
    const urls = [...new Set(raw.map((u) => String(u).trim()).filter(isHttp))].slice(0, 30);
    const existing = new Set(
      (await env.DB.prepare('SELECT url FROM items WHERE url IS NOT NULL').all<{ url: string }>()).results.map((r) => dedupeKey(r.url)),
    );
    const fresh = urls.filter((u) => !existing.has(dedupeKey(u)));
    const scraped = await Promise.allSettled(fresh.map(scrape));
    let added = 0;
    for (const s of scraped) if (s.status === 'fulfilled') { await insertItem(env, s.value); added++; }
    return json({ added, skipped: urls.length - fresh.length, failed: fresh.length - added });
  }

  const itemMatch = p.match(/^\/api\/items\/([\w-]{8,64})(\/reserve)?$/);
  if (itemMatch) {
    const [, id, reserve] = itemMatch;
    if (!reserve && m === 'PATCH') {
      await requireOwner(req, env);
      const f = sanitize(await readJson(req));
      if (!f.title) throw new HttpError(400, 'Title can’t be empty.');
      const res = await env.DB.prepare(
        `UPDATE items SET title=?, url=?, source=?, category=?, image=?, price=?, currency=?, notes=?, starred=? WHERE id=?`,
      ).bind(f.title, f.url, f.source, f.category, f.image, f.price, f.currency, f.notes, f.starred, id).run();
      if (!res.meta.changes) throw new HttpError(404, 'That item no longer exists. Refresh the list.');
      return json({ item: toItem((await getRow(env, id))!, true) });
    }
    if (!reserve && m === 'DELETE') {
      await requireOwner(req, env);
      await env.DB.prepare('DELETE FROM items WHERE id=?').bind(id).run();
      return json({ ok: true });
    }
    if (reserve && m === 'POST') {
      const body = await readJson(req);
      const name = clean(body.name, 60) || 'Someone';
      const token = crypto.randomUUID();
      const res = await env.DB.prepare(
        'UPDATE items SET reserved_by=?, reserved_at=?, reserve_token_hash=? WHERE id=? AND reserved_at IS NULL',
      ).bind(name, Date.now(), await sha256(token), id).run();
      if (!res.meta.changes) {
        const row = await getRow(env, id);
        throw row ? new HttpError(409, 'Someone just reserved this one.') : new HttpError(404, 'That item no longer exists.');
      }
      return json({ token, item: toItem((await getRow(env, id))!, false) });
    }
    if (reserve && m === 'DELETE') {
      const row = await getRow(env, id);
      if (!row) throw new HttpError(404, 'That item no longer exists.');
      const owner = await isOwner(req, env);
      if (!owner) {
        const body = await readJson(req);
        const token = String(body.token || '');
        if (!token || !row.reserve_token_hash || (await sha256(token)) !== row.reserve_token_hash) {
          throw new HttpError(403, 'Only the person who reserved this can release it.');
        }
      }
      await env.DB.prepare('UPDATE items SET reserved_by=NULL, reserved_at=NULL, reserve_token_hash=NULL WHERE id=?').bind(id).run();
      return json({ item: toItem((await getRow(env, id))!, owner) });
    }
  }

  const imgMatch = p.match(/^\/api\/img\/([\w-]{8,64})$/);
  if (imgMatch && m === 'GET') return proxyImage(env, imgMatch[1]);

  throw new HttpError(404, 'Not found.');
}

/* ───────────────────────── Index page (per-list share title) ───────────────────────── */

async function renderIndex(req: Request, env: Env): Promise<Response> {
  const page = await env.ASSETS.fetch(req);
  let s = DEFAULT_SETTINGS;
  try { s = await getSettings(env); } catch { /* DB not migrated yet: use defaults */ }
  const title = `${s.title} · Gift OS`;
  return new HTMLRewriter()
    .on('title', { element: (e) => { e.setInnerContent(title); } })
    .on('meta[property="og:title"]', { element: (e) => { e.setAttribute('content', s.title); } })
    .on('meta[property="og:description"], meta[name="description"]', { element: (e) => { e.setAttribute('content', s.headline); } })
    .transform(page);
}

/* ───────────────────────── Data ───────────────────────── */

async function getSettings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of results) if (r.key in out && r.value) out[r.key] = r.value;
  return out;
}

async function listItems(env: Env, owner: boolean) {
  const { results } = await env.DB.prepare('SELECT * FROM items ORDER BY created_at DESC').all<Row>();
  return results.map((r) => toItem(r, owner));
}

const getRow = (env: Env, id: string) => env.DB.prepare('SELECT * FROM items WHERE id=?').bind(id).first<Row>();

async function insertItem(env: Env, f: Fields): Promise<Row> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO items (id, title, url, source, category, image, price, currency, notes, starred, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, f.title, f.url, f.source, f.category, f.image, f.price, f.currency, f.notes, f.starred, Date.now()).run();
  return (await getRow(env, id))!;
}

/** Public shape. Who reserved something is only ever sent to the owner. */
function toItem(r: Row, owner: boolean) {
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    source: r.source,
    category: r.category,
    image: r.image ? `/api/img/${r.id}?v=${hash(r.image)}` : null,
    rawImage: owner ? r.image : undefined,
    price: r.price,
    currency: r.currency,
    notes: r.notes,
    starred: !!r.starred,
    createdAt: r.created_at,
    reserved: r.reserved_at != null,
    reservedBy: owner ? r.reserved_by : undefined,
  };
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
    source: clean(b.source, 80) || (url ? hostOf(url) : null),
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
  if (!env.OWNER_PASSWORD) throw new HttpError(500, 'Owner password isn’t configured on the server yet.');
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
  const value = `${exp}.${await sign(env, String(exp))}`;
  return json({ ok: true }, 200, { 'set-cookie': cookie(value, SESSION_DAYS * 86400) });
}

function cookie(value: string, maxAge: number) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function isOwner(req: Request, env: Env): Promise<boolean> {
  if (!env.OWNER_PASSWORD) return false;
  const m = (req.headers.get('cookie') || '').match(new RegExp(`${SESSION_COOKIE}=(\\d+)\\.([\\w-]+)`));
  if (!m || Number(m[1]) < Date.now()) return false;
  return safeEqual(m[2], await sign(env, m[1]));
}

async function requireOwner(req: Request, env: Env) {
  if (!(await isOwner(req, env))) throw new HttpError(401, 'Sign in as the owner to do that.');
}

async function sign(env: Env, data: string): Promise<string> {
  // Keyed on the password, so changing OWNER_PASSWORD signs everyone out.
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('giftos-session:' + env.OWNER_PASSWORD),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return b64url(new Uint8Array(d));
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
    if (!r.ok || !type.startsWith('image/')) return new Response('Bad image', { status: 502 });
    return new Response(r.body, {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=604800, immutable', 'x-content-type-options': 'nosniff' },
    });
  } catch {
    return new Response('Image unavailable', { status: 502 });
  }
}

/* ───────────────────────── Scraper ───────────────────────── */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export async function scrape(url: string): Promise<Fields> {
  let html = '';
  let finalUrl = url;
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(9000),
    });
    if (r.ok && (r.headers.get('content-type') || '').includes('html')) {
      html = (await r.text()).slice(0, 2_000_000);
      finalUrl = r.url || url;
    }
  } catch { /* fall through to URL-derived defaults */ }

  const meta = parseMeta(html);
  const ld = parseProductLd(html);
  const docTitle = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');

  let title = ld.name || meta['og:title'] || meta['twitter:title'] || docTitle;
  title = tidyTitle(title) || slugTitle(url) || hostOf(url);

  let image = ld.image || meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'] || '';
  try { image = image ? new URL(image, finalUrl).href : ''; } catch { image = ''; }

  const priceRaw = ld.price ?? meta['product:price:amount'] ?? meta['og:price:amount'] ?? meta['price']
    ?? (html.match(/"price"\s*:\s*"?(\d+(?:\.\d{1,2})?)"?/) || [])[1];
  const price = parseFloat(String(priceRaw ?? '').replace(/[^0-9.]/g, ''));
  const currency = (ld.currency || meta['product:price:currency'] || meta['og:price:currency'] || 'USD').toUpperCase();

  return sanitize({
    title,
    url,
    source: hostOf(url),
    category: guessCategory(`${title} ${url}`),
    image: isHttp(image) ? image : '',
    price: Number.isFinite(price) && price > 0 ? price : '',
    currency,
  });
}

function parseMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop')).toLowerCase();
    const content = attr(tag, 'content');
    if (key && content && !(key in out)) out[key] = decode(content);
  }
  return out;
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
}

function parseProductLd(html: string): { name?: string; image?: string; price?: string; currency?: string } {
  const blocks = html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of blocks) {
    let data: unknown;
    try { data = JSON.parse(body.trim()); } catch { continue; }
    const product = findProduct(data);
    if (!product) continue;
    const img = product.image;
    const image = typeof img === 'string' ? img : Array.isArray(img) ? (typeof img[0] === 'string' ? img[0] : img[0]?.url) : img?.url;
    const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    const offer = offers?.offers ? (Array.isArray(offers.offers) ? offers.offers[0] : offers.offers) : offers;
    return {
      name: typeof product.name === 'string' ? decode(product.name) : undefined,
      image,
      price: offer?.price ?? offer?.lowPrice ?? offers?.lowPrice,
      currency: offer?.priceCurrency ?? offers?.priceCurrency,
    };
  }
  return {};
}

// deno-lint-ignore no-explicit-any
function findProduct(node: any, depth = 0): any {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findProduct(n, depth + 1); if (f) return f; } return null; }
  const t = node['@type'];
  if (t === 'Product' || (Array.isArray(t) && t.includes('Product')) || t === 'ProductGroup') return node;
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
    const f = findProduct(node[k], depth + 1);
    if (f) return f;
  }
  return null;
}

function tidyTitle(t: string): string {
  t = decode(t).replace(/\s+/g, ' ').trim()
    .replace(/^amazon\.[a-z.]+\s*:\s*/i, '')
    .replace(/\s*:\s*[A-Z][\w\s&]*$/, (s) => (s.length < 40 ? '' : s)); // "...: Sports & Outdoors"
  const parts = t.split(/\s+[|–—·]\s+/);
  if (parts.length > 1 && parts[0].length >= 8) t = parts[0];
  t = t.replace(/\.\s*[A-Z][\w-]*\.com$/i, ''); // "Shoes. Nike.com"
  return t.slice(0, 200).trim();
}

function slugTitle(url: string): string {
  try {
    const segs = new URL(url).pathname.split('/').map(decodeURIComponent)
      .filter((s) => /[a-z]{3,}/i.test(s) && /[-_]/.test(s) && !/^(dp|p|product|products|item)$/i.test(s));
    const best = segs.sort((a, b) => b.length - a.length)[0];
    if (!best) return '';
    return best.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  } catch { return ''; }
}

function guessCategory(text: string): string {
  text = text.toLowerCase();
  const map: [string, RegExp][] = [
    ['Golf', /golf|driver|wedge|putter|iron set|taylormade|callaway|titleist|scotty cameron/],
    ['Shoes', /shoe|sneaker|vomero|pegasus|adizero|running-shoe|boots?\b/],
    ['Tech', /macbook|iphone|ipad|drone|dji|headphone|airpods|camera|gpu|ssd|laptop|monitor|keyboard|meta glasses/],
    ['Apparel', /polo|shirt|pants|hoodie|jacket|shorts|lululemon|dri-fit|sweater/],
    ['Fragrance', /parfum|cologne|fragrance|eau de/],
    ['Fitness', /jiu.?jitsu|\bgi\b|dumbbell|kettlebell|rogue|whoop|garmin|yoga/],
    ['Home', /kitchen|coffee|espresso|blanket|candle|lamp|cookware/],
    ['Books', /book|kindle|hardcover|paperback/],
  ];
  for (const [cat, re] of map) if (re.test(text)) return cat;
  return 'Other';
}

/* ───────────────────────── Helpers ───────────────────────── */

async function readJson(req: Request): Promise<Record<string, any>> {
  try { const b = await req.json(); return b && typeof b === 'object' ? b as Record<string, any> : {}; }
  catch { return {}; }
}

const isHttp = (s: string) => /^https?:\/\/[^\s]+$/i.test(s);
const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function dedupeKey(url: string): string {
  try { const u = new URL(url); return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/+$/, '').toLowerCase(); }
  catch { return url; }
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function decode(s: string): string {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
