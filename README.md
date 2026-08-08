# Pager Watch — Incident Board

A live, operational board for volunteer brigade pager traffic. Parses raw pager
lines, displays them in a control-room style table, and lets you filter by
incident number, district, call class, alarm level, tags, or free text.

Built on Next.js (App Router) so the path to **Vercel + Supabase** is short.

## Run locally

```bash
npm install
npm run dev
# open http://localhost:3000
```

The board boots seeded with sample incidents so every filter works immediately.

## Pager line format

```
{alarmLevel} {stationCode} - {incidentNo} - {type} - {callClass} - {address} - [{lng},{lat}]
```

Example:

```
2 STSUTTO - 26-118273 - Chimney fire - FIRECALL - 10 NORTH ST,SUTTON,YASS VALLEY (NSW),2620 - [149.255855,-35.158894]
```

The address splits on commas into street / suburb / district (LGA) / postcode,
with the state pulled from the `(NSW)` parenthetical. See `lib/parser.ts`.

## Feeding in real data

The UI polls `GET /api/incidents` every 5s. Push live traffic with:

```bash
curl -X POST http://localhost:3000/api/incidents \
  -H "Content-Type: application/json" \
  -d '{"message":"2 STSUTTO - 26-118273 - Chimney fire - FIRECALL - 10 NORTH ST,SUTTON,YASS VALLEY (NSW),2620 - [149.255855,-35.158894]"}'
```

Accepts `{ "message": "..." }`, `{ "messages": ["...", "..."] }`, or a
plain-text body with one line per row.

## The raw feed (`/raw`)

The board is a *filtered* view: only numbered RFS/FRNSW jobs reach it. SES
traffic, stand-downs, test pages and decode noise are all thrown away on the way
in.

`/raw` is the firehose behind it — every line every source saw, tagged with what
the pipeline did with it (**on board** / **stand-down** / **dropped**), plus
search and status filters. Reach it from the **Raw feed** button in the board's
header.

Lines are deduplicated by content, so one page picked up by pocsag, telegram and
rfspager is a single row listing all three sources with a `×3` repeat count. The
dedup key is a sha256 of the whitespace-normalised text — computed in
`lib/raw-feed.ts` and, for the one-time backfill, in `supabase/schema.sql`. The
two must stay in step or old rows stop deduplicating against new ones.

## Architecture / expansion points

```
app/
  page.tsx              server component, renders the access gate
  raw/page.tsx          the raw feed, behind the same gate
  api/incidents/route.ts GET (list) + POST (ingest raw lines)
  api/raw/route.ts      GET the raw feed (search + status filter, keyset paged)
components/
  AccessGate.tsx        per-device invite gate; picks board vs. raw feed
  PagerBoard.tsx        client UI: filtering, facets, live polling
  RawFeed.tsx           client UI: the unfiltered stream
lib/
  types.ts              Incident + PagerMessage shapes (map 1:1 to Supabase tables)
  parser.ts             raw pager line -> Incident (forgiving)
  filter.ts             which lines are allowed onto the board
  raw-feed.ts           normalise / hash / classify, and record the raw stream
  store.ts              ** data-source seam — the one file to change for Supabase **
  supabase.ts           step-by-step notes + table schema
  sample-data.ts        seed lines
```

Ingestion runs in one place: sources hand `feeder/poster.ts` everything they see,
it records the raw stream first, then applies the board filter. A source only
overrides that by setting `boardEligible: false` on a line it knows can't be a
board row (pocsag's `ignore` flag, SES agency traffic, an rfspager row with no
usable timestamp) — such lines are still recorded, just never parsed.

### Moving to Supabase

1. `npm install @supabase/supabase-js`
2. Create the `incidents` table (schema in `lib/supabase.ts`).
3. Fill `.env.local` from `.env.example`.
4. Re-implement the four functions in `lib/store.ts` against Supabase. The API
   routes and UI need no changes.

### Deploying to Vercel

Import the repo in Vercel, add the same env vars, and deploy. `force-dynamic`
is already set on the page and API route so the board always reflects live data.

## Ideas already scaffolded for

- Click an **incident number** to filter to it.
- Click any **district**, **call class**, **alarm level**, or **tag** to filter.
- Tags are auto-derived from the job type (fire / rescue / hazmat / storm / …).
- Coordinates link straight to Google Maps.
