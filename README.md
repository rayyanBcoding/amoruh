# AMORUH Live OS

The internal operating system for AMORUH's TikTok Live selling business.

**One barcode scan controls the whole show**: scanning an internal SKU barcode
updates the Operator Dashboard, the TV Display, and inventory — instantly,
with no page refresh, across every open tab/window.

This is the V1 MVP. It runs entirely on a local JSON file as the database and
has no TikTok Shop integration yet, by design — see [Roadmap](#roadmap) for
how it's structured to grow into that.

## Stack

Next.js 16 (App Router) · React · TypeScript · Tailwind CSS v4 · Framer Motion

## Getting started

```bash
npm install
npm run dev
```

Then open:

- **[/dashboard](http://localhost:3000/dashboard)** — Operator Dashboard (control center)
- **[/tv](http://localhost:3000/tv)** — TV Display (open on the TV behind the auctioneer)
- **[/inventory](http://localhost:3000/inventory)** — Inventory table + Product Editor

`/` redirects to `/dashboard`.

## Try the barcode flow

The Operator Dashboard has a barcode input that auto-focuses (a physical USB/
Bluetooth scanner behaves like a keyboard, so this just works). To try it
without a scanner, click the field and type one of the seed SKUs, then press
Enter:

```
LD000101   Dior Sauvage EDT
LD000102   Chanel Bleu de Chanel EDP
LD000103   Versace Eros EDT
LD000104   Viktor & Rolf Spicebomb Extreme
LD000105   Creed Aventus
LD000106   Jean Paul Gaultier Le Male Le Parfum
```

Open `/tv` in a second tab/window first — you'll see it update live the
moment you scan.

## How the real-time sync works

```
Operator Dashboard  ─┐
                      ├─  GET /api/events (SSE, held open)  ◄── liveEmitter (in-process pub/sub)
TV Display           ─┘                                            ▲
                                                                     │ broadcastStateChanged()
Any mutation (scan, next, mark sold,        POST /api/scan, /api/state/*, PUT /api/products/[id]
flash deal, product edit) ──────────────────────────────────────────┘
```

Every mutating route handler writes to the JSON "database" then calls
`broadcastStateChanged()`. Every open `/api/events` connection (one per
Dashboard/TV tab) picks that up, re-reads a fresh `LiveSnapshot`, and pushes
it down over Server-Sent Events. The client-side `LiveStateProvider`
(`src/context/LiveStateContext.tsx`) is the single source of truth React
components read from — no manual refetching or polling.

## Project structure

```
data/                     "Database" — products.json + state.json
public/images/products/   Placeholder bottle art (swap for real photos)

src/lib/
  types.ts                Product, Sale, LiveState, LiveSnapshot
  db.ts                   All JSON read/write logic — swap this file for a
                           real DB later, nothing else needs to change
  events.ts               In-process pub/sub used to fan out SSE updates
  format.ts                Currency/time formatting helpers

src/app/api/
  products/, products/[id]/         Catalog CRUD
  scan/                             The barcode endpoint
  state/, state/next/, state/sold/,
  state/flash-deal/, state/select/,
  state/queue/                      Live-show state mutations
  events/                           SSE stream

src/context/LiveStateContext.tsx    Client-side live state + actions

src/components/          Shared UI (Button, Badge, BottleImage, Nav, ...)
src/components/dashboard/  Operator Dashboard panels
src/components/tv/         TV Display stage + animated transitions
src/components/inventory/  Inventory table + Product Editor form

src/app/dashboard/       Operator Dashboard page
src/app/tv/               TV Display page
src/app/inventory/        Inventory table
src/app/inventory/[id]/   Product Editor
```

## Roadmap

The codebase is deliberately laid out so each of these is additive, not a
rewrite:

- **TikTok Shop API** — swap `src/lib/db.ts`'s product source for a synced
  cache of TikTok's catalog; `findProductByCode` and the `Product` shape stay.
- **Automatic label printing** — the dashboard's "Print Label" button already
  calls out to a single spot; replace the placeholder with a real print job.
- **Order management / shipping** — `Sale` records in `state.json` are the
  seed of an orders table; promote them to their own store when ready.
- **OBS overlays / Stream Deck** — both are just more SSE clients or POSTers
  against the existing `/api/scan` and `/api/state/*` routes.
- **Multiple TVs / multiple operators** — already true today: every `/tv` and
  `/dashboard` tab is its own SSE client reading the same shared state.
- **Real database** — only `src/lib/db.ts` reads/writes the JSON files;
  everything else calls its exported functions and doesn't know or care.
