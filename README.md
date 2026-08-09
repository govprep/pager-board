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

## Phone alerts: choosing your areas

Tapping **🔔 Alerts on** in the header opens the area picker. A device either
gets **everything** (the default, and what every already-subscribed device keeps
doing) or only the areas it picks. Preferences live per *device*, not per member
— a phone and a tablet on the same invite code can watch different areas.

Areas are chosen two ways, because the agencies page differently:

| | what the page carries | how you subscribe |
|---|---|---|
| **RFS** | a full address ending in the LGA — `…,MOSS VALE,WINGECARRIBEE (NSW),2577` | pick the **LGA** |
| **FRNSW** | no address at all — `FRINC TYPE: AFA TURNOUT: 428 INC: 155212-09082026` | type the **station number** |

The two lists are independent and OR'd: an incident alerts you if its LGA is on
your list *or* any of its turnouts is. Picking an LGA does **not** pull in the
FRNSW stations inside it — that mapping isn't in the pager data, so it would
have to be guessed.

Two things follow from the data, both worth knowing:

- The LGA is located by its `(NSW)` parenthetical, not by counting commas — a
  cross-street or road name adds a segment and shifts it right.
- About 2% of RFS pages arrive with no usable address and no turnout. They reach
  everyone on "everything" and nobody who has narrowed.

LGA names are matched on a normalised key (case, punctuation and council-type
suffixes removed), so `QUEANBEYAN PALERANG`, `Queanbeyan-Palerang Regional` and
`LAKE MACQUARIE CITY` all match the way you'd expect. Anything not listed can
still be typed in.

The picker's options are the 71 areas in `lib/nsw-lgas.ts` — every LGA the feed
has ever paged, harvested from the full PagerMon archive (71,100 messages, of
which 40,157 carried an address) — merged with whatever is on the loaded board,
which contributes the live counts and always wins on spelling. Without the seed
the picker would only ever offer wherever happened to be busy at the time.

That harvest also turned up spellings the feed emits that aren't the real name —
`PORT MACQUARIE COUNCIL` (144 pages), `CAMPELLTOWN CITY` (37) — so `LGA_ALIASES`
folds them onto the right area and a subscriber doesn't quietly miss them. One-off
decode truncations (`ERANG`, `WAREE`) are left alone rather than guessed at.

To refresh the list, sweep PagerMon's `/api/messages` with `limit=100&page=N`
and run each message through `lgaFromLocation()`. Note `since` only walks
*forward* from the newest message, so it can't page back through history.

The FRNSW station list (`lib/frnsw-stations.ts`) is the full 335-station index
from [fire.nsw.gov.au](https://www.fire.nsw.gov.au/contact/contact-details/locations/station-index),
verified against every turnout number the live feed has actually paged.

### Custom notification tones

Not possible from a web app, and not a matter of effort. The Notifications API
had a `sound` option; it was never implemented by any browser and was removed
from the standard in 2018, because the platforms' notification centres can't
support it properly. So:

- **iOS** (installed PWA) — the system notification sound only. No API, and web
  push can't use Critical Alerts.
- **Android** — the app can't set a sound, but *the user* can: Chrome files each
  site's notifications under their own channel, so a per-site tone can be chosen
  in the OS notification settings.
- **While the board is open** a page can of course play any audio it likes; a
  real pager tone here would be a small addition. It can't help when the app is
  closed, which is when it would matter most.

A genuinely custom tone (or one that overrides silent mode) needs a native app
wrapper, not a PWA.

## Architecture / expansion points

```
app/
  page.tsx              server component, renders the access gate
  raw/page.tsx          the raw feed, behind the same gate
  api/incidents/route.ts GET (list) + POST (ingest raw lines)
  api/raw/route.ts      GET the raw feed (search + status filter, keyset paged)
  api/push/prefs/route.ts GET/PUT a device's alert areas
components/
  AccessGate.tsx        per-device invite gate; picks board vs. raw feed
  PagerBoard.tsx        client UI: filtering, facets, live polling
  RawFeed.tsx           client UI: the unfiltered stream
  AlertPrefs.tsx        the area picker modal (LGAs + FRNSW stations)
lib/
  types.ts              Incident + PagerMessage shapes (map 1:1 to Supabase tables)
  parser.ts             raw pager line -> Incident (forgiving)
  filter.ts             which lines are allowed onto the board
  lga.ts                pull the LGA out of an RFS address, and normalise it
  nsw-lgas.ts           every LGA the feed has paged, + its misspellings
  alert-prefs.ts        who gets pushed what — shared by the API and the feeder
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
