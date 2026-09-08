# Hazards: Live Traffic NSW (and the Waze question)

Road and area conditions, alongside the pager traffic. The question they answer
is not "what is the job" but "what is between us and it" — a closure on the
Kings Hwy at 2am is worth knowing before the truck leaves the shed.

## Why they are not incidents

`incidents` is keyed on the incident number, upserted through a merge that
compares two decodes of the same page, cancelled by stand-downs, and fanned out
to Slack and phones. A hazard fits none of that:

- **no incident number** — its identity is the publisher's own id;
- **a lifecycle in days, not minutes.** It opens, is edited many times, and
  closes. A roadwork runs for months;
- **line geometry as often as a point.** A closure is a stretch of road;
- **volume that would bury the board**, and must never reach a phone.

So they have their own table (`hazards`), their own writer
(`feeder/hazard-poster.ts`), and their own read path — sharing with the board
only the shape of the code. The guarantee that a lane closure can never wake
someone at 2am is that the code path it travels has no phone in it.

## Setting it up

1. Sign up at [the TfNSW Open Data Hub](https://opendata.transport.nsw.gov.au),
   create an application, and tick **Live Traffic Hazards**.
2. Put the key in `.env.local` as `TFNSW_API_KEY`.
3. Apply `supabase/migrations/202609080001_hazards.sql`.
4. `npm run feeder` — Live Traffic starts alongside the pager sources, and
   silently skips itself if the key is absent.

The feed is CC-BY. **Wherever hazards are drawn, Transport for NSW has to be
named** — that attribution belongs with the map layer.

## Shape of it

`https://api.transport.nsw.gov.au/v1/live/hazards/{category}/open`, with
`Authorization: apikey KEY`, per category:

| category | polled | why |
|---|---|---|
| `incident`, `fire`, `flood` | 60s | matters in the minutes it is happening |
| `roadwork`, `majorevent`, `alpine` | 15 min | a fact about next month |

Everything is clipped to `HAZARD_BBOX` on the way in — the feed is statewide,
and unclipped it is several hundred Sydney roadworks. The clip reads the
geometry, not the suburb, so a closure whose line starts near Sydney and ends
near Goulburn is kept.

### The field mapping is unverified

`toHazard()` in `feeder/sources/livetraffic.ts` was written from the published
Live Traffic developer guide, **not from a live response** — there was no API
key on hand. Every read is defensive and the whole feature is stored in
`hazards.raw`, so if a field name is wrong the fix is that one function and a
re-poll, with nothing lost in the meantime.

First run with a real key, check: `headline`, `displayName`, `roads[].suburb`,
`created`/`lastUpdated`/`start`/`end` (epoch millis is assumed, and `toIso()`
tolerates seconds and ISO strings), `isMajor`, `isEnded`, `webLinkUrl`.

### How a hazard ends

It doesn't announce it. It is in `/open` one minute and absent the next, so each
poll is a full picture of one category and anything not in it is over. The
writer stamps `last_seen_at` on everything it saw, then closes the rows in that
category still carrying an older stamp.

An **empty** response is ambiguous — a genuinely quiet category looks exactly
like a request that returned nothing useful — so an empty poll closes only what
has been missing 45 minutes, comfortably longer than the slowest category's
interval.

## Waze

Not available, and the reason is worth writing down so it isn't re-litigated.

The intended route is a [Waze for Cities](https://www.waze.com/wazeforcities/)
partnership: a public agency applies, is approved for a managed-area polygon,
and receives a GeoRSS feed of alerts, jams and irregularities every ~2 minutes.
Emergency services are explicitly eligible, so the brigade or district could
apply. That feed would drop into this table as a second source file next to
`livetraffic.ts` — nothing in `lib/hazards.ts` or the writer knows what a
publisher's fields look like.

The live map is **not** a substitute for that. `www.waze.com/live-map` renders
fine in a browser, but its data endpoint
(`/live-map/api/georss?top=&bottom=&left=&right=&env=row`) returns a flat `403`
to any request that isn't the page itself — verified against several bounding
boxes, including central Sydney where there is certainly data. The page config
carries `"enableRecaptcha": true` and a reCAPTCHA Enterprise site key: the
endpoint is behind bot detection, and reaching it means defeating that, not
merely setting a User-Agent. The old `rtserver/web/TGeoRSS` paths now 404.

So the map layer, when it lands, shows Live Traffic. Waze is a partnership away.
