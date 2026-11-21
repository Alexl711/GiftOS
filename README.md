# Gift OS

A wishlist website you can share with a link.

- **`/`**: the public wishlist. Gift-givers browse sections, see "Most wanted", get gift ideas by budget, and reserve things so nobody doubles up.
- **`/admin`**: where you (the owner) paste product links. Each link is read **in the background**: title, photo and price are pulled from the store page automatically.

Runs on **Cloudflare Workers** with **D1** (SQLite). No build step.

## How links are read (`src/scrape.ts`)
1. The store page itself: JSON-LD product data, Open Graph / product meta tags, microdata, Amazon markup, embedded price JSON
2. Shopify's public product JSON for Shopify stores
3. [Microlink](https://microlink.io) (free tier) for sites that block direct requests: title + photo
4. The URL itself, for a readable title if all else fails

Anything missing shows under **Needs a look** in admin, where you can add a price or photo by hand, or hit **Refresh price & photo** later.

## Local development
```bash
npm install
echo 'OWNER_PASSWORD="pick-something"' > .dev.vars
npx wrangler d1 migrations apply giftos --local
npm run dev        # http://localhost:8787  and  http://localhost:8787/admin
```

## Deploy
```bash
npx wrangler login
npx wrangler d1 create giftos              # paste the database_id into wrangler.jsonc
npx wrangler d1 migrations apply giftos --remote
npx wrangler secret put OWNER_PASSWORD
npx wrangler deploy
```
Changing `OWNER_PASSWORD` signs out every owner session.
