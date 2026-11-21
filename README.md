# Gift OS

A wishlist website. Gift-givers browse it and reserve items so nobody doubles up; the owner signs in to add, edit, star and remove things.

Runs on **Cloudflare Workers** (API + static site) with **D1** (SQLite) for storage.

## Features
- Paste a product link: title, image, price and category are pulled from the page (JSON-LD, Open Graph, or the URL itself)
- Paste many links at once, or add an item with no link
- Gift-givers reserve without an account; only the person who reserved (or the owner) can release it
- Gift-givers never see who reserved what; the owner can, or can turn on **Surprise mode** to hide all reservations
- "Most wanted" items, notes for givers ("size 10.5"), categories, search, sorting
- Images are proxied and cached, so stores that block hotlinking still show up
- Light and dark mode, mobile-first

## Local development
```bash
npm install
npx wrangler d1 migrations apply giftos --local
npm run dev            # http://localhost:8787  (password from .dev.vars)
```
Create `.dev.vars` with `OWNER_PASSWORD="something"`.

## Deploy
```bash
npx wrangler login
npx wrangler d1 create giftos          # paste the database_id into wrangler.jsonc
npx wrangler d1 migrations apply giftos --remote
npx wrangler secret put OWNER_PASSWORD
npx wrangler deploy
```
Your site is then live at `https://giftos.<your-subdomain>.workers.dev`. Add a custom domain under Workers → giftos → Settings → Domains & Routes.

Changing `OWNER_PASSWORD` signs out every owner session.
