/**
 * Product link reader: given a store URL, find the title, photo and price.
 *
 * Tries, in order (stopping as soon as photo + price are both known):
 *   1. The page itself: JSON-LD Product data, Open Graph / product meta tags,
 *      microdata, and store-specific markup (Amazon, Shopify, generic "price" JSON).
 *   2. Shopify's public product JSON (`/products/<handle>.js`) for Shopify stores.
 *   3. Microlink (free metadata service) for sites that block direct requests.
 *   4. The URL itself, for a readable title when nothing else works.
 */

export type Scraped = {
  title: string;
  image: string | null;
  price: number | null;
  currency: string;
  source: string;
  category: string;
  found: { title: boolean; image: boolean; price: boolean };
};

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

type Partial = { title?: string; image?: string; price?: number; currency?: string };

export async function scrape(url: string): Promise<Scraped> {
  const acc: Partial = {};
  const merge = (p: Partial) => {
    if (!acc.title && p.title) acc.title = p.title;
    if (!acc.image && p.image) acc.image = p.image;
    if (acc.price == null && p.price != null && p.price > 0) { acc.price = p.price; acc.currency = p.currency || acc.currency; }
    if (!acc.currency && p.currency) acc.currency = p.currency;
  };
  const done = () => acc.title && acc.image && acc.price != null;

  const page = await fetchPage(url);
  if (page) merge(fromHtml(page.html, page.url));
  if (!done()) merge(await fromShopify(page?.url || url, page?.html || ''));
  if (!done()) merge(await fromMicrolink(url));

  const title = tidyTitle(acc.title || '') || slugTitle(url) || hostOf(url);
  return {
    title,
    image: acc.image && isHttp(acc.image) ? acc.image : null,
    price: acc.price != null ? Math.round(acc.price * 100) / 100 : null,
    currency: /^[A-Z]{3}$/.test((acc.currency || '').toUpperCase()) ? acc.currency!.toUpperCase() : 'USD',
    source: hostOf(url),
    category: guessCategory(`${title} ${url}`),
    found: { title: !!acc.title, image: !!acc.image, price: acc.price != null },
  };
}

/* ───────────── 1. The page ───────────── */

async function fetchPage(url: string): Promise<{ html: string; url: string } | null> {
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'upgrade-insecure-requests': '1',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('html')) return null;
    const html = (await r.text()).slice(0, 3_000_000);
    if (/captcha|robot check|are you a human|access denied/i.test(html.slice(0, 20000)) && !/og:image/i.test(html)) return null;
    return { html, url: r.url || url };
  } catch {
    return null;
  }
}

export function fromHtml(html: string, base: string): Partial {
  const meta = parseMeta(html);
  const ld = parseProductLd(html);
  const out: Partial = {};

  out.title = ld.name || meta['og:title'] || meta['twitter:title'] ||
    decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim() || undefined;

  const amazonImg =
    attrOf(html, /<img[^>]+id=["']landingImage["'][^>]*>/i, 'data-old-hires') ||
    firstKey(attrOf(html, /<img[^>]+id=["']landingImage["'][^>]*>/i, 'data-a-dynamic-image')) ||
    (html.match(/"hiRes"\s*:\s*"(https:[^"]+)"/) || [])[1];
  const img = ld.image || meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] ||
    meta['twitter:image'] || meta['twitter:image:src'] || amazonImg || meta['image'] ||
    (html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)/i) || [])[1];
  out.image = absolutize(img, base);

  const priceStr = ld.price ?? meta['product:price:amount'] ?? meta['og:price:amount'] ?? meta['price'] ??
    meta['twitter:data1'] ??
    (html.match(/class=["']a-offscreen["'][^>]*>\s*[^\d<]{0,4}([\d.,]+)/) || [])[1] ??           // Amazon
    (html.match(/"(?:price|salePrice|currentPrice|finalPrice)"\s*:\s*\{?[^}]{0,40}?"?(\d{1,6}(?:\.\d{1,2})?)"?/) || [])[1];
  out.price = parsePrice(priceStr);
  out.currency = ld.currency || meta['product:price:currency'] || meta['og:price:currency'] || meta['pricecurrency'] ||
    (html.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/) || [])[1];
  return out;
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

function attrOf(html: string, tagRe: RegExp, name: string): string {
  const m = html.match(tagRe);
  return m ? decode(attr(m[0], name)) : '';
}

function firstKey(json: string): string {
  try { return Object.keys(JSON.parse(json))[0] || ''; } catch { return ''; }
}

type LD = { name?: string; image?: string; price?: string; currency?: string };

function parseProductLd(html: string): LD {
  for (const [, body] of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(body.trim()); } catch { continue; }
    const p = findProduct(data);
    if (!p) continue;
    const variant = Array.isArray(p.hasVariant) ? p.hasVariant[0] : null;
    const img = p.image ?? variant?.image;
    const image = typeof img === 'string' ? img : Array.isArray(img) ? (typeof img[0] === 'string' ? img[0] : img[0]?.url || img[0]?.contentUrl) : img?.url || img?.contentUrl;
    const offers0 = p.offers ?? variant?.offers;
    const offers = Array.isArray(offers0) ? offers0[0] : offers0;
    const offer = offers?.offers ? (Array.isArray(offers.offers) ? offers.offers[0] : offers.offers) : offers;
    const spec = offer?.priceSpecification;
    const specOne = Array.isArray(spec) ? spec[0] : spec;
    return {
      name: typeof p.name === 'string' ? decode(p.name) : undefined,
      image,
      price: offer?.price ?? offer?.lowPrice ?? offers?.lowPrice ?? specOne?.price,
      currency: offer?.priceCurrency ?? offers?.priceCurrency ?? specOne?.priceCurrency,
    };
  }
  return {};
}

// deno-lint-ignore no-explicit-any
function findProduct(node: any, depth = 0): any {
  if (!node || typeof node !== 'object' || depth > 7) return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findProduct(n, depth + 1); if (f) return f; } return null; }
  const t = node['@type'];
  const is = (x: string) => t === x || (Array.isArray(t) && t.includes(x));
  if (is('Product') || is('ProductGroup') || is('IndividualProduct')) return node;
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item', 'about']) {
    const f = findProduct(node[k], depth + 1);
    if (f) return f;
  }
  return null;
}

/* ───────────── 2. Shopify ───────────── */

async function fromShopify(url: string, html: string): Promise<Partial> {
  let u: URL;
  try { u = new URL(url); } catch { return {}; }
  const m = u.pathname.match(/\/products\/([^/?#]+)/);
  if (!m || (html && !/shopify/i.test(html) && !/\/products\//.test(u.pathname))) return {};
  try {
    const r = await fetch(`${u.origin}/products/${m[1]}.js`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return {};
    // deno-lint-ignore no-explicit-any
    const j: any = await r.json();
    const img = j.featured_image || j.images?.[0];
    return {
      title: j.title,
      image: img ? absolutize(img.startsWith('//') ? 'https:' + img : img, u.origin) : undefined,
      price: typeof j.price === 'number' ? j.price / 100 : undefined,
    };
  } catch { return {}; }
}

/* ───────────── 3. Microlink ───────────── */

async function fromMicrolink(url: string): Promise<Partial> {
  try {
    const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(9000) });
    if (!r.ok) return {};
    // deno-lint-ignore no-explicit-any
    const j: any = await r.json();
    if (j.status !== 'success') return {};
    const d = j.data || {};
    return { title: d.title || undefined, image: d.image?.url || undefined };
  } catch { return {}; }
}

/* ───────────── Helpers ───────────── */

export const isHttp = (s: string) => /^https?:\/\/[^\s]+$/i.test(s);

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function absolutize(src: string | undefined, base: string): string | undefined {
  if (!src) return undefined;
  try { const u = new URL(src.trim(), base); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined; }
  catch { return undefined; }
}

export function parsePrice(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v > 0 ? v : undefined;
  let s = String(v).replace(/[^\d.,]/g, '');
  if (!s) return undefined;
  // "1.299,00" (EU) -> 1299.00 ; "1,299.00" (US) -> 1299.00
  if (/,\d{2}$/.test(s) && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/,\d{2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? n : undefined;
}

export function tidyTitle(t: string): string {
  t = decode(t).replace(/\s+/g, ' ').trim()
    .replace(/^amazon\.[a-z.]+\s*:\s*/i, '')
    .replace(/\s*:\s*(?:Amazon\.[a-z.]+|[A-Z][\w\s&,]*)$/, (s) => (s.length < 45 ? '' : s));
  const parts = t.split(/\s+[|–—·]\s+|\s+-\s+(?=[A-Z][\w.]+(?:\.com)?$)/);
  if (parts.length > 1 && parts[0].length >= 8) t = parts[0];
  t = t.replace(/\.\s*[A-Z][\w-]*\.com$/i, '');
  return t.slice(0, 200).trim();
}

export function slugTitle(url: string): string {
  try {
    const segs = new URL(url).pathname.split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } })
      .filter((s) => /[a-z]{3,}/i.test(s) && /[-_]/.test(s) && !/^(dp|p|product|products|item|gp)$/i.test(s));
    const best = segs.sort((a, b) => b.length - a.length)[0];
    if (!best) return '';
    return best.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  } catch { return ''; }
}

export function guessCategory(text: string): string {
  text = text.toLowerCase();
  const map: [string, RegExp][] = [
    ['Golf', /golf|driver|wedge|putter|iron set|taylormade|callaway|titleist|scotty cameron/],
    ['Shoes', /shoe|sneaker|vomero|pegasus|adizero|running-shoe|\bboots?\b|loafer/],
    ['Tech', /macbook|iphone|ipad|drone|dji|headphone|airpods|camera|gpu|ssd|laptop|monitor|keyboard|speaker|switch 2|playstation|xbox/],
    ['Clothing', /polo|shirt|pants|hoodie|jacket|shorts|lululemon|dri-fit|sweater|jeans|dress/],
    ['Beauty', /parfum|cologne|fragrance|eau de|skincare|serum/],
    ['Fitness', /jiu.?jitsu|\bgi\b|dumbbell|kettlebell|rogue|whoop|garmin|yoga|treadmill/],
    ['Home', /kitchen|coffee|espresso|blanket|candle|lamp|cookware|mug|bottle/],
    ['Books', /\bbook|kindle|hardcover|paperback/],
    ['Toys', /lego|toy|puzzle|board game/],
  ];
  for (const [cat, re] of map) if (re.test(text)) return cat;
  return 'Other';
}

export function decode(s: string): string {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
const safeChar = (n: number) => { try { return String.fromCodePoint(n); } catch { return ''; } };
