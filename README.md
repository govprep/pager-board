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

The board requires an enrolled device and a configured Supabase database. See `docs/access.md` for invite management and `docs/audit.md` for the security migration and local validation.

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

The board loads `GET /api/incidents` once and is live after that on Supabase
Realtime: a row arrives as its own payload and goes straight onto the board, so
a page costs no request at all. It re-reads only on a heartbeat every 30s (in
case the socket dropped), on returning to the foreground, and after a wipe —
`DELETE` is the one change whose payload carries no row. Push live traffic with:

```bash
curl -X POST http://localhost:3000/api/incidents \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
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
| pager.forcequit.xyz | PagerMon REST, 60s, through a SOCKS proxy | only with `FEEDER_PROXY_FORCEQUIT` set — see below |
| pager-feed.net | PagerMon Socket.IO, live | yes |
| Telegram group (`TG_SESSION`) | MTProto, live | yes |

The three public instances are all PagerMon, so they share one table of hosts
(`feeder/sources/public-pagermon.ts`). Adding an instance is a line in that
table; dropping one is deleting the line. Two of them are read over the live
socket (`feeder/sources/pagermon-live.ts`) and forcequit over the REST API
(`feeder/sources/pagermon-api.ts`), which is the `transport` field on the entry
— see below for why that one differs.

pager.forcequit.xyz earns its place on receiver coverage: its lines are the same
full-fidelity decodes as pocsag's (capcode on every message, addresses complete
with LGA and coordinates), but it listens in the south. In a two-day sample, 33
of the 57 incident numbers it carried inside the board's window were ones no
other source had — mostly Illawarra and Shoalhaven, where the rest of the feed
is thin.

The feeder host cannot reach it directly. Cloudflare returns 403 to that IP on
every path and every transport, with or without a browser User-Agent, so this
only appeared on deployment.

**Retested 2026-09-06 — still blocked.** `/` and
`/socket.io/?EIO=3&transport=polling` both 403 in ~30ms, with and without
browser headers, from `170.64.236.23`. The response is Cloudflare's
`server: cloudflare`, `cf-ray: a369b6a98f505081-SYD`, and the body is the
firewall block page — *"Sorry, you have been blocked / You are unable to access
forcequit.xyz"* — not the interstitial challenge Bot Fight Mode serves. So this
is a **WAF rule on the zone**, and it names the apex domain rather than the
pager subdomain. That matters for who can lift it: it's a deliberate rule in
someone's dashboard, not a toggle we can wait out, and no amount of header
tuning on our end will pass it.

The tidy fix is still to ask. What to send whoever runs the host: the IP
(`170.64.236.23`), the Ray ID above, and what the request actually is — a
minute-by-minute read of `pager.forcequit.xyz`'s message API. Cloudflare's own
block page tells the visitor to email the site owner with exactly that Ray ID.
It's the only fix that leaves nothing running.

**The socket path closed on 2026-09-07.** Separately from the IP block above,
`/socket.io/` began answering with the same WAF block page *through the proxy* —
that is, to the residential IP the zone otherwise serves normally. It is the
path that is blocked, not the client: measured from the same exit within the
same minute, `/` answered 200, `/api/messages` answered 200, and a path that
doesn't exist still 404'd, while `/socket.io/` stayed 403 across query strings,
a full Chrome header set, `Origin`/`Referer`, cookies from a prior page load,
HTTP/1.1 and h2, and the path re-cased. The last message this source recorded
was 13:24 AEST that day.

Anything that would get the socket back from here means defeating bot detection
on a host we don't run, which isn't a road this project goes down. The same
messages are on the same host's REST API, which its own web page uses and which
`robots.txt` allows (`User-agent: *` / `Allow: /`), so the instance is polled
there instead — `transport: "api"` on its table entry, implemented in
`feeder/sources/pagermon-api.ts`.

Two measured properties of that endpoint set the shape of the poller. It
answers newest-first and ignores `since`, so the cursor is ours to keep rather
than the server's; and it carries about 21.5 messages an hour, so one
`limit=50` page is over two hours of traffic and a 60s poll has no way to
outrun it. That interval is set by politeness rather than by staleness — this
is somebody else's host, and it is a good deal gentler than the socket client
it replaces, which reconnected thousands of times.

#### Routing it through a connection that isn't blocked

The same request from a residential connection is waved through, so that one
socket — and only that one — can go out through a SOCKS5 proxy parked on such a
connection. Set `FEEDER_PROXY_FORCEQUIT` and the instance switches itself on;
leave it unset and it stays off with a startup line saying so, exactly as
before. The variable is named after the instance's label
(`FEEDER_PROXY_<LABEL>`, non-alphanumerics folded to `_`), so any instance can
be routed the same way if another host ever blocks us. The other five sources
keep their direct path either way.

The proxy end is one command on a machine at home, and nothing installed:

```bash
ssh -N -R 1080 root@170.64.236.23 \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3
```

`-R` with a port and no destination is OpenSSH's **reverse** dynamic forward
(7.6+, and the Windows 10/11 built-in client has it): the home machine dials
*out*, and the feeder host gets a SOCKS5 proxy on `127.0.0.1:1080` whose traffic
leaves from the home connection. That direction is what makes it practical on a
residential line — no inbound port, no port forward, no dynamic DNS, and it
survives the IP changing. It binds to loopback only, so nothing is exposed on
the droplet's public interface. Give the tunnel its own restricted account
rather than root if you'd rather; it needs to log in and nothing else.

Then on the feeder host, in `.env.local`:

```
FEEDER_PROXY_FORCEQUIT=socks5://127.0.0.1:1080
```

Verify before restarting the feeder — the point is that these two disagree:

```bash
curl -o /dev/null -w '%{http_code}\n' \
  'https://pager.forcequit.xyz/api/messages?limit=1'                          # 403
curl -o /dev/null -w '%{http_code}\n' --socks5-hostname 127.0.0.1:1080 \
  'https://pager.forcequit.xyz/api/messages?limit=1'                          # 200
```

On startup the feeder logs `[forcequit] routing via socks5://127.0.0.1:1080`
and then `[forcequit] polling …/api/messages, cursor seeded at id N, replaying
M message(s)`.

That replay is the one behaviour where the poller differs from the socket it
replaced, and it is deliberate. A socket only ever delivered what arrived after
it connected, so anything paged while the feeder was restarting was simply
lost. A poller can see it, and for this source that backlog is most of the
value — it covers the south, where a job it carries is usually one no other
source has. So the seed page is posted rather than dropped, with only its
newest 30 board-worthy lines still counted as news; the rest are recorded in
the raw feed and kept off the board. Re-posting pages the board already knows
is cheap and quiet: `feeder/poster.ts` dedupes raw lines on a hash of the text,
and `feeder/push.ts` refuses anything older than 30 minutes, so nobody's phone
buzzes for a job that finished an hour ago.

Keep the tunnel supervised — a Task Scheduler job at logon on Windows (set it to
restart on failure), or a systemd unit with `Restart=always` on a Linux box.
When it drops, that one instance logs `poll failed` once a minute while
everything else carries on, and picks up again by itself when the tunnel is
back — a poll that fails deliberately leaves the cursor where it was, so the
messages it couldn't read are still ahead of the mark when it recovers. The
silence watchdog below covers the two socket instances; a polled one has no
socket to stall.

An unusable `FEEDER_PROXY_*` value is refused rather than ignored — the feeder
logs `not connecting — unusable proxy` (or `not polling — unusable proxy`)
and leaves that instance down. Connecting
direct instead would mean 403ing in a loop while the log claimed a proxy was in
use, and `socks-proxy-agent` silently ignores an `http://` URL, so only
`socks…://` is accepted.

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

Those additions used to be silent — `feeder/push.ts` skipped any unit-addition to
an already-alerted incident. Now they carry the response as it builds: a device
that has **narrowed to areas** starts following every job that alerts it, so the
appliances assigned after the first page arrive as "CMEASCR1 was added to
RINGWOOD RD" rather than only appearing on the card. Devices on alert-everything
are left out — they haven't said what their patch is, and following on their
behalf would mean every appliance on every job in the state. Slack still posts
them all as replies inside the job's existing thread.

That is only bearable because this feed's headline strength is also its noise:
duty officers and ops (`LHDO`, `CCDO`, `SHOPS14`) are paged to nearly everything
in a zone, and a follow-up naming only those is dropped rather than sent — see
`lib/units.ts`. The pages are still stored and still shown; they just don't ring.
The Follow button on the card turns an auto-follow off, and unfollowing sticks.

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

#### How fast a page reaches the board

Measured over a week of `pager_messages` (5,908 numbered lines, 1,306 distinct
jobs). Two different questions, and they give different answers, so both are
here.

**Who gets a job to us first**, in wall-clock — no trust in anyone's
self-reported timestamps, just which source's copy landed earliest:

| source | won the race | covers | behind the winner (p50 / p90) |
|---|---|---|---|
| pager-feed | **71%** | 73% | 0.0s / 0.0s |
| pagermon | 10% | 71% | 11.2s / 26.1s |
| pocsag | 10% | **15%** | 0.0s / 38.6s |
| telegram | 7% | 30% | 14.3s / 104.7s |
| rfspager | 3% | 74% | 16.5s / 60.6s |

The surprise is that **pager-feed.net is the fast path** — the instance kept for
depth rather than breadth is first for seven jobs in ten, and drops thin. Its
copy is what puts most jobs on the board; the fuller copy that decides what the
row finally says arrives a median 17s later from someone else. That's the
`fullerOf()` / `dropWeakerThanStored()` machinery earning its keep on the
critical path, not just at the edges.

The other surprise is **pocsag's 15% coverage**, against 71–74% for the three
sources either side of it. Over three days it was silent for 84% of the window
with gaps of six hours, where pager-feed on the identical code path was quiet
26% and never longer than 83 minutes. A Socket.IO connection that stops
delivering looks exactly like a quiet night from the inside — the socket stays
open, ping/pong keeps passing, no `disconnect` fires — so `reconnection: true`
never had anything to react to. Hence the silence watchdog in
`sources/pagermon-live.ts`: liveness is judged on messages arriving, and a feed
that has said nothing for 20 minutes is torn down and redialled. Its log line
also settles which of the two possible causes it is — if redialling restores
traffic the fault was ours, and if it doesn't, pocsag's receivers really have
gone quiet.

**What our own pipeline costs.** Every Supabase round trip from the feeder host
is ~200ms — measured against an *empty* RPC, so it's the hop to the origin, not
query time (the Cloudflare edge in front of it answers in 0.9ms, which is why
this doesn't show up in a ping). Ingest was four to five of those in series,
which is most of the ~1.0s pager-feed takes to appear. `poster.ts` now starts
the raw-feed write without waiting on it, since `incidents` and `pager_messages`
share no keys and nothing downstream reads the raw feed back.

### Where everything physically runs

The largest remaining costs are geography, not code. Measured from the feeder
host (DigitalOcean Sydney) on 2026-09-06:

| hop | now | if moved |
|---|---|---|
| NSW user → Vercel function | **~270ms** (`iad1`, Virginia) | ~10ms (`syd1`) |
| Vercel function → Supabase | ~230ms (Virginia → Singapore) | ~2ms (both Sydney) |
| feeder → Supabase | **~200ms** (Sydney → Singapore) | ~15ms |

Two separate misplacements, and neither is obvious from the dashboard:

- **Vercel functions run in `iad1`**, its default for new projects. An
  unauthenticated `/api/incidents` — which returns 401 from a local JWT check
  and never touches the database — takes ~270ms from Sydney. That is the floor
  under every board request, paid before any work happens. `vercel.json` now
  pins `regions: ["syd1"]`; a single non-default region is available on every
  plan including Hobby.
- **The Supabase project is in `ap-southeast-1` (Singapore)**, not
  `ap-southeast-2`. Confirmed by resolving `db.<ref>.supabase.co` to
  `2406:da18::/35` and matching it against AWS's published ranges. A TCP
  handshake to Supabase's Singapore pooler is 253ms from the feeder host,
  against 2ms to the Sydney one. The 200ms the feeder actually sees is lower
  than the raw 253ms because PostgREST is fronted by Cloudflare, whose Sydney
  edge is 0.9ms away and holds a warm path to the origin — which is also why
  none of this shows up in a ping.

Supabase cannot change a project's region in place; it means a new project and a
cutover. Nothing here uses Supabase Auth, Storage or Edge Functions, and
`public/sw.js` caches nothing, so the moving parts are the seven tables, the
`record_pager_messages()` function, the Realtime publication, and four
environment variables. Device enrolment survives, because the credential is a
row in `member_devices` rather than anything Supabase issues.

Poll intervals turned out to matter far less than they look. rfspager is first
for 3% of jobs and dropping it entirely would have delayed just 24 of 1,306
(median 0s), so it stays at 90s rather than leaning harder on someone else's
page; `RFSPAGER_POLL_MS` is there if that changes. PagerMon is self-hosted, so
it went to 15s (`PAGERMON_POLL_MS`) — cheap, and it only ever matters for the
pages no live socket hears at all.

## A job that changes after it alerts

Most jobs don't arrive complete. Control pages more brigades to them minutes
later, and re-types them as the picture firms up — an AFA that turns out to be
real is re-paged as a structure fire. Both land as *changes to a row already on
the board*, which is exactly the kind of change someone who has read that row
will never look at again. So the board points at them:

- **Anything about the job changes** → *the row* blinks blue three times — hard
  on, hard off, no fade, 700ms blue with a 420ms gap (`tr.data-row.changed` in
  `globals.css`, `FLASH_MS` in `components/PagerBoard.tsx`). Three and not two
  because the row is trying to catch someone who isn't looking at the board: a
  glance that arrives late still sees the pattern repeat. A re-type, an address
  that comes through fuller or corrected, a resource added, a resource stood down:
  one flash for all of them, and the same one a newly paged job gets, because
  "this is different from the last time you looked" is a single question and
  shouldn't need two vocabularies to answer. Blue, because red on this board
  means a resource has been *stood down*.
- **A resource is added** → *that badge* blinks too, on the row's beat run
  backwards: blue while the row is dark, its own colours through the 700ms the
  row spends blue (`.badge.added`). Being the one thing on the row out of step
  with it is what makes it findable — on a job already running six appliances,
  the row says the job changed and the badge says which resource is the change.
- Changes are diffed against what the board *draws*, not against the rows behind
  it — a re-type or a fuller address is reconciled across a job's pages, so the
  diff runs on the merged view (`mergeEntries()`). Two things never flash: a job
  we've never held unless it was paged in the last ten minutes (scrolling into
  history also produces unseen jobs), and anything an older page brought with it,
  which is a page from an hour ago arriving rather than the job moving.
- **The type is updated** → the board follows the latest page that carried a
  type, not the fullest one. This is the single exception to the rule above:
  every other field on a merged row comes from whichever page recorded the job
  most completely (`fullerOf()`), because a thin copy is worse than an old one.
  For the type that inverts — a stale type is worse than a thin one, since it is
  what tells someone what they're driving to — and the update typically rides in
  on a later, thinner page than the rest of the row. `isLaterType()` in
  `lib/incident-merge.ts` still refuses a blank type, and breaks a same-second
  tie on length, so a clipped decode can't pass itself off as a re-type.

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

## The live map (`/map`)

Every job of the last few hours, where it happened. Reach it from the **Map**
button in the board's header. It runs on the same Realtime socket the board
does, so a page lands on both at the same moment.

The window is 1 / 4 / 12 / 24 hours and defaults to four — a shift's worth of
traffic — and the choice sticks to the device. A job is one marker, not one per
appliance: the rows are reconciled by `lib/entries.ts`, the same code the board
draws from.

**Not every page says where it is.** Placement is decided in
`lib/incident-points.ts`, in three grades, and the map draws each differently:

| grade | where the position comes from | how it's drawn |
|---|---|---|
| exact | coordinates on the page itself | filled dot, hard white edge |
| station | FRNSW: the responding station's suburb | faded dot inside a soft ring |
| address | an address that carried no coordinates | faded dot inside a soft ring |

FRNSW is why the other two grades exist. A FRNSW page is
`FRINC TYPE: AFA TURNOUT: 66 INC: 156572` — no address, no coordinates, only the
turnout number of the station that was sent — and that is most of the traffic.
Dropping those would leave the map showing a fraction of what is happening, so
they go on the station's suburb and say so three times over: in the key
("Approximate"), in the marker (a ring rather than a pin), and in the card
("this page carried no address, so it sits on the responding station's suburb").

Jobs sharing a suburb are scattered by a couple of hundred metres — a hash of
the job's own key, so it doesn't move between renders — because otherwise four
jobs in Queanbeyan stack into one marker and the map understates the night.

Suburb and address lookups are Mapbox forward-geocodes, cached in `localStorage`
for 30 days (`lib/geocode.ts`): a suburb is asked about once, however many jobs
land in it and however many times the map is opened.

The rest of it:

- **Heat** — a heatmap weighted by recency, so a 24-hour window still shows
  where the last hour was rather than an even wash over the day. It fades out as
  the markers become individually readable.
- **Clusters** — below street zoom, markers collapse into counted circles;
  tapping one opens it.
- **A new job announces itself** — a blue card at the top of the screen (tap it
  and the map flies there), a ring pulsing on the marker for two minutes, and
  optionally a chime (**♪**, off by default: the tap that turns it on is the
  gesture browsers require before a page may make a noise). This is in-page and
  only while the map is open — the push notifications in *Phone alerts* below
  are the ones that reach a pocket.
- **Sat** — satellite imagery instead of the dark basemap. **Fit** re-frames
  everything currently on the map.
- Tapping a marker opens a card: type, time, where, the resources paged, a link
  into the platform's maps app, and **Full details**, which opens that job's
  full card back on the board.

On a phone the controls are two rows of glass pills over the top of the map and
the card becomes a sheet at the bottom, so the map itself keeps the screen.

It needs `NEXT_PUBLIC_MAPBOX_TOKEN` — the same token the incident card's map
already uses. Without one the page says so and points back at the board.

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
  map/page.tsx          the live map, behind the same gate
  api/incidents/route.ts GET (list) + POST (ingest raw lines)
  api/raw/route.ts      GET the raw feed (search + status filter, keyset paged)
  api/push/prefs/route.ts GET/PUT a device's alert areas
  api/push/subscribe/route.ts enrol a device, retiring the endpoint it replaced
components/
  AccessGate.tsx        per-device invite gate; picks board, raw feed or map
  PagerBoard.tsx        client UI: filtering, facets, live polling
  RawFeed.tsx           client UI: the unfiltered stream
  LiveMap.tsx           client UI: the last few hours, on a map
  IncidentMap.tsx       the single-job map inside the incident card
  AlertPrefs.tsx        the area picker modal (LGAs + FRNSW stations)
lib/
  types.ts              Incident + PagerMessage shapes (map 1:1 to Supabase tables)
  parser.ts             raw pager line -> Incident (forgiving)
  entries.ts            rows -> the jobs on screen; shared by the board and the map
  incident-points.ts    where a job goes on the map, and how exactly we know it
  geocode.ts            browser-side forward geocoding, cached for 30 days
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
