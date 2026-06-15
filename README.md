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

## Architecture / expansion points

```
app/
  page.tsx              server component, seeds initial board
  api/incidents/route.ts GET (list) + POST (ingest raw lines)
components/
  PagerBoard.tsx        client UI: filtering, facets, live polling
lib/
  types.ts              Incident shape (maps 1:1 to a Supabase table)
  parser.ts             raw pager line -> Incident (forgiving)
  store.ts              ** data-source seam — the one file to change for Supabase **
  supabase.ts           step-by-step notes + table schema
  sample-data.ts        seed lines
```

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
