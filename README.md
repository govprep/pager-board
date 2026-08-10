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

## Where the traffic comes from

`npm run feeder` runs every source at once. They overlap heavily on purpose — a
page one receiver misses, or decodes badly, usually arrives intact from another,
and the raw feed collapses the copies into a single row listing each source that
saw it.

| source | transport | on the board? |
|---|---|---|
| your PagerMon (`PAGERMON_URL`) | REST, authenticated, `id` cursor | yes |
| rfspager.app | HTML scrape, 90s | yes |
| pocsag.net | PagerMon Socket.IO, live | yes |
| pager.forcequit.xyz | PagerMon Socket.IO, live | yes — **currently blocked**, see below |
| pager-feed.net | PagerMon Socket.IO, live | yes |
| Telegram group (`TG_SESSION`) | MTProto, live | yes |

The three public instances are all PagerMon, so they share one client
(`feeder/sources/pagermon-live.ts`) and one table of hosts
(`feeder/sources/public-pagermon.ts`). Adding an instance is a line in that
table; dropping one is deleting the line.

pager.forcequit.xyz earns its place on receiver coverage: its lines are the same
full-fidelity decodes as pocsag's (capcode on every message, addresses complete
with LGA and coordinates), but it listens in the south. In a two-day sample, 33
of the 57 incident numbers it carried inside the board's window were ones no
other source had — mostly Illawarra and Shoalhaven, where the rest of the feed
is thin.

It is nonetheless **switched off**, because the feeder host can't reach it.
Cloudflare returns 403 to that IP on every path and every transport, with or
without a browser User-Agent, the body naming "bot" — the zone blocking a
datacenter IP, most likely Bot Fight Mode. It connects normally from a
residential connection, so this only appeared on deployment. Nothing on our side
fixes it: the way back is to have the server's IP allowlisted by whoever runs
the host, then delete the `disabled` line from `PUBLIC_INSTANCES`. Until then it
logs one line at startup instead of retrying every 30 seconds forever.

### What pager-feed.net is for, and what it isn't

It publishes a *tidied* rendering of the traffic rather than the decode. Against
the same job, the difference is the whole address:

```
pocsag / rfspager:  VRCESSN391 - 26-123379 - VRA - INDUSTRIAL/DOMESTIC RESCUE -
                    95 FIGTREE LN,KIAH RD,GILLIESTON HEIGHTS,MAITLAND (LGA),2321
                    - [151.52509,-32.74652]
pager-feed.net:     VRCESSN391 - 26-123379 - Industrial/Domestic Rescue -
                    95 FIGTREE LANE, KIAH ROAD, GILLIESTON HEIGHTS
```

It's here for **depth, not breadth**. Its receiver hears capcodes the others
don't — duty officers and ops especially (`LHDO`, `CCDO`, `LHOPS18`) — and since
a board row is keyed on `{incidentNo}-{unit}`, each of those is a row no other
source produces. Over a two-day sample it added 80 unit pages to jobs already on
the board, against only 3 incident numbers nobody else had. Judge it on units,
not incidents; on incidents alone it looks worthless.

Those additions are quiet by design: `feeder/push.ts` skips unit-additions to an
incident that has already alerted, and Slack posts them as replies inside the
job's existing thread.

**Its FRNSW pages** arrive laid out with dashes instead of keys:

```
FRINC: MEDICAL ACCESS EMERGENCY - 234 - INC: 156043
```

Same three facts as the canonical form, so `lib/parser.ts` reads it as layout C
rather than treating it as a different kind of page: type, turnout, incident
number. It keys on the bare turnout exactly as the canonical reader does, so a
page arriving in both layouts is **one row, not two**, and the number resolves
through the usual station index — `234` displays as `234 BOWRAL`.

`frnswTurnouts()` in `lib/frnsw-stations.ts` has to know the layout too, and its
regex must stay in step with the parser's. That one isn't cosmetic: a device
subscribed to station 234 matches on what it returns, so a layout it can't read
is a page that silently alerts nobody.

What it can't offer: its RFS pages have no coordinates and no LGA. For an extra
unit on a job that's already known this doesn't bite, because `mergeAlertKeys`
pools the keys across all of a job's pages, so a sibling page supplies the LGA.
For the handful of jobs only it sees, it does — no map pin, and invisible to any
device that has narrowed to an area.

### Never trade a full row for a thin one

Every source writes to the same row for the same page, so the board used to show
whichever copy landed last. `feeder/poster.ts` now refuses an upsert that would
cost a stored row either of the two things that carry weight — its coordinates
(the map pin, the Slack static map) or its LGA (what a narrowed device matches
on). The losing copy is dropped whole rather than merged field by field, so a
row never ends up pairing one source's address with another's `raw`.

This is what makes pager-feed safe to parse: without it, that one instance would
have overwritten 168 good rows in a two-day sample. It also caught a bug that
predates it — truncated decodes from rfspager and pagermon (`location: ""`,
`"RAMSAY RD,FIFT"`) had been quietly blanking good addresses.

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
  cross-street or road name adds a segment and shifts it right. Some pages label
  the segment `(LGA)` instead of the state, VRA rescue jobs especially, so both
  count.
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

### When the areas don't seem to be respected

`npm run alerts` lists every enrolled phone and exactly what it's set to;
`npm run alerts check <incident-no>` replays the feeder's matching for one job
and shows which devices it reached. Between them they cover the three ways a
phone ends up buzzing for somewhere it never asked for:

- **The feeder is on old code.** The filtering lives in `feeder/push.ts`, in the
  long-running feeder process — not in the web app. A feeder started before the
  area picker shipped keeps pushing everything to everyone no matter what the
  picker saves. On startup it now logs `[push] enabled — area filtering on`;
  no line, no filtering. Restart it.
- **The device never chose.** Anything enrolled before the picker existed sits on
  `alert_all` — a default, not a choice. The board now opens the picker once,
  unprompted, on such a device; `npm run alerts` shows them as
  `everything (never chose)`, and `npm run alerts forget <endpoint-tail>` cuts
  one loose.
- **The device has a stale twin.** Push services rotate endpoints, and the old
  row used to stay behind on its own preferences, pushing alongside the new one —
  one phone, two subscriptions, only one of them narrowed. Subscribing now names
  the device (a SHA-256 of its invite token, in `device_key`), carries its chosen
  areas onto the new endpoint and deletes the old row. Rows written before this
  have no `device_key` and can't be paired up retroactively — `forget` them.

Backfill is the fourth source of unwanted buzzing, and isn't about areas at all:
re-scraping history re-upserts old rows with no `pushed_at`, and each one rings
as breaking news. Pages received more than `PUSH_MAX_AGE_MIN` minutes ago
(default 30) are marked pushed without notifying.

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
  api/push/subscribe/route.ts enrol a device, retiring the endpoint it replaced
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
  push-client.ts        browser side: subscribe, device id, save/read areas
  raw-feed.ts           normalise / hash / classify, and record the raw stream
  store.ts              ** data-source seam — the one file to change for Supabase **
  supabase.ts           step-by-step notes + table schema
  sample-data.ts        seed lines
feeder/
  index.ts              starts every source
  poster.ts             the one ingest path: record raw, filter, parse, upsert
  sources/
    pagermon.ts         your private PagerMon, over the authenticated REST API
    pagermon-live.ts    ** the PagerMon Socket.IO client every public host shares **
    public-pagermon.ts  ** the table of public hosts — add/remove one here **
    rfspager.ts         rfspager.app HTML scraper
    telegram.ts         a Telegram group
```

Ingestion runs in one place: sources hand `feeder/poster.ts` everything they see,
it records the raw stream first, then applies the board filter. A source only
overrides that by setting `boardEligible: false` on a line it knows can't be a
board row (PagerMon's `ignore` flag, SES agency traffic, an rfspager row with no
usable timestamp, anything from a `rawOnly` instance) — such lines are still
recorded, just never parsed.

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
