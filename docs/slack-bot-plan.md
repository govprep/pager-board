# Slack incident bot — plan

Mirror parsed pager incidents into Slack: **one parent message per real-world
incident, one threaded reply per responding unit**, posted into per-area
channels. Optional Mapbox map on the parent and Claude Haiku for friendly type
names.

```
#area-wamboin
└─ 🚨 INCIDENT: STRUCTURE FIRE
   34 Bingley Way, Wamboin, Queanbeyan-Palerang     [static map]
   26-119228 · 27/06/2026, 4:12 pm
   ├─ LGWAMBO1A assigned to this incident.
   └─ 428 QUEANBEYAN assigned to this incident.
```

## Decisions

| Area | Choice | Why |
|------|--------|-----|
| Routing | **Text lookup table** (`lib/area-channels.ts`) | Predictable, debuggable, easy to extend. Coords/polygon routing deferred. |
| AI scope | **Type naming only**, Haiku-4.5, off the hot path | Headlines are deterministic from parsed fields; AI only expands unknown short codes, cached, never blocks a page. |
| Map | **Mapbox static image w/ marker** | One API call from `coords`, no AI, renders inline in Slack. |
| Threading key | `incidentNo` (fallback: page `id`) | The incident number is shared across a job's pages; it's the natural thread key. |
| Where it runs | **Feeder**, hooked after the Supabase upsert | Feeder already owns ingest, parse, dedup, and write. |

## Core model

The existing `Incident` is really a **page** (one parsed line per unit, keyed
`incidentNo-unit`). Slack wants the real-world incident as the unit of grouping:

- New `incidentNo` → **parent** message; store its `thread_ts`.
- Same `incidentNo` → **reply** in that thread (incl. the first unit).
- Blank `incidentNo` (SES/some FRNSW) → falls back to the page `id`, so it stands
  alone.

## State

```sql
-- incidents: NULL = not yet posted; stamped after a successful Slack post.
alter table public.incidents add column if not exists slacked_at timestamptz;

-- One row per job; records the thread its pages reply into.
create table if not exists public.incident_threads (
  incident_no text        primary key,
  channel     text        not null,
  thread_ts   text        not null,
  created_at  timestamptz not null default now()
);
```

`slacked_at` makes posting idempotent: a page is sent only while it's NULL, then
stamped. Re-sent pages and feeder restarts never double-post. Slack failures
leave it NULL so the next batch retries; permanent skips (no channel) get stamped
so they don't loop.

## Flow (`feeder/slack.ts` → `postPending(db, ids)`)

1. No-op unless `SLACK_BOT_TOKEN` is set.
2. Select the given ids where `slacked_at IS NULL`, oldest first.
3. For each page:
   - `channel = channelForLocation(location)`. None and no default → stamp & skip.
   - Look up `incident_threads` by group key.
     - Miss → post parent (header + location + map + context), capture `ts`,
       insert thread row (duplicate-key tolerated for concurrency).
   - Post `*UNIT* assigned to this incident.` reply into the thread.
   - On success, collect the id.
4. Stamp all collected ids `slacked_at = now()`.

## Files

| File | Role | Status |
|------|------|--------|
| `supabase/schema.sql` | `slacked_at` column + `incident_threads` table | ✅ built |
| `lib/area-channels.ts` | location → channel (ordered: suburb, then LGA) | ✅ built (placeholder channels) |
| `lib/maps.ts` | Mapbox static-map URL from coords | ✅ built |
| `feeder/type-names.ts` | static dict + Haiku fallback, cached | ✅ built |
| `feeder/slack.ts` | parent/reply threading + posting | ✅ built |
| `feeder/poster.ts` | calls `postPending` after upsert; `clear()` wipes threads | ✅ wired |
| `.env.example` | new env vars documented | ✅ built |

`npx tsc --noEmit` passes.

## Config

```
SLACK_BOT_TOKEN=xoxb-…        # scope chat:write; bot invited to each area channel
SLACK_DEFAULT_CHANNEL=#incidents   # unmatched locations (blank = skip them)
MAPBOX_TOKEN=pk.…             # blank = no map image
ANTHROPIC_API_KEY=…           # blank = types just title-cased
```

## Activation steps

1. Run the new `alter table` / `create table` from `schema.sql` (idempotent).
2. Create the Slack app, add `chat:write`, install, grab the `xoxb-` token,
   **invite the bot to every area channel**.
3. Fill `.env.local` with the four vars above.
4. Replace the placeholder channels in `lib/area-channels.ts` with real ones.
5. `npm run feeder`.

## Known limits / follow-ups

- **Routing only as good as the table** — watch `SLACK_DEFAULT_CHANNEL` early to
  discover suburbs/LGAs to add.
- **Single feeder process assumed** — check-then-post on `incident_threads` is
  safe at ~90s poll intervals; multiple feeder processes would need a real claim
  lock.
- **Deferred:** coords/LGA-polygon routing, AI situational one-liner, satellite
  map style, interactive buttons (ack / on-scene), persisting Haiku results
  across runs.

## Possible v2

- Tests against `lib/sample-data.ts` for threading + routing.
- AI one-line context on the parent (Haiku) once threading is proven.
- Point-in-polygon routing fallback using NSW LGA GeoJSON + `coords`.
