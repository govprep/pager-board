# A real iPhone app — plan

Ship BelterHub as a native iPhone app: an **Expo / React Native** client against
the existing API and Supabase, and an **APNs** transport alongside web push in
the feeder. The board's logic (`lib/`) is reused verbatim; only the view layer
and the notification transport are new.

## Why bother — what native actually buys

The PWA already does most of what the app will do. Be honest about which
problems this solves, because they're all one problem:

| | PWA today | native app |
|---|---|---|
| **Custom pager tone** | impossible — the `sound` option was removed from the Notifications standard in 2018 | bundled `.caf`, per alert kind |
| **Breaks a Focus / Do Not Disturb** | no | yes — `interruption-level: time-sensitive`, free entitlement |
| **Breaks the ringer switch / silent mode** | no | yes — *if* Apple grants Critical Alerts |
| **Volume** | system notification volume | critical alerts set their own, up to 1.0 |
| **Repeat until acknowledged** | no | yes (re-push on a timer until the job is opened) |
| **Survives "clear website data"** | no — localStorage jar | Keychain, survives everything but delete |
| **Install** | Add to Home Screen, then type the code | TestFlight, then type the code |
| Board UI, filters, map, realtime | already good | the same, rebuilt |

Everything above the line is why this is worth doing. Everything below it is
work we take on to get there. A pager that can't be heard over a silenced phone
at 3am is the entire point of the exercise; the table and filters are already
fine and will not get meaningfully better in React Native.

**What it does not fix:** the feeder is still a single long-running process, and
it is still the only thing that sends alerts. APNs is best-effort delivery, not
a pager network. Neither of those changes; if anything the app raises the stakes
on feeder uptime, because people will trust it more.

## Decisions

| Area | Choice | Why |
|------|--------|-----|
| Framework | **Expo (React Native), managed workflow** | `lib/` is pure TypeScript and ports untouched. Dev machine is Windows — **EAS Build compiles on Apple's runners, so no Mac is needed**. Swift/SwiftUI would mean a Mac plus a second copy of the parser. |
| First build | **Expo shell around a WebView**, native push from day one | Puts real tones on real phones in about a week. The board is already a good mobile web UI; replace it screen by screen afterwards, not before. |
| Push transport | **Direct APNs**, HTTP/2, token auth (`.p8`) | No third party in the alerting path. Expo's push service would be one fewer moving part and one more thing between a page and a phone. |
| Push token storage | Same `push_subscriptions` table, `endpoint` = `apns://<hex token>` | Keeps the FK from `incident_subscriptions`, the `device_key` reconcile, the prefs API, and `npm run alerts` working with no changes. |
| Auth | Unchanged — `/api/enroll` → device token → `/api/session` JWT | Already device-scoped and already survives a fresh storage jar. Only the storage moves: localStorage → Keychain. |
| Data | Supabase JS + Realtime, same as the browser | Same client, same `realtime.setAuth()`, same RLS. |
| Distribution | **TestFlight**, indefinitely | Members-only app for a brigade. App Store review would be a fight over Guideline 4.2/5.1.1 for no gain. |
| Android | Not now, but nothing here blocks it | Same Expo codebase; the transport work is the only iOS-specific part, and FCM would slot in beside APNs the same way. |

## Part 1 — the alerting path (server side)

This is the half that matters, and it's all in code we already own. It can ship
and be tested from a plain Expo dev build before a single board screen is
rebuilt.

### Schema (`supabase/schema.sql`)

```sql
-- Which transport this row is reached over. 'web' keeps every existing row
-- behaving exactly as it does now.
alter table public.push_subscriptions
  add column if not exists platform text not null default 'web';

-- APNs has no encryption keys — they're web push's. Existing rows keep theirs.
alter table public.push_subscriptions alter column p256dh drop not null;
alter table public.push_subscriptions alter column auth   drop not null;

-- Per-device tone and how hard it's allowed to shout. Null tone = system default.
alter table public.push_subscriptions
  add column if not exists tone     text;
alter table public.push_subscriptions
  add column if not exists critical boolean not null default false;
```

`endpoint` stays the primary key and stays the identity of a device everywhere
else in the system — an iOS row just carries `apns://<64 hex chars>` instead of
a push service URL. That one decision is what keeps `incident_subscriptions`,
the follow API, the prefs API, the device_key reconcile and `scripts/alerts.ts`
from needing to know that iOS exists.

### `feeder/apns.ts` (new, ~100 lines)

Token-based APNs, hand-rolled on `node:http2` and **`jose`, which is already a
dependency** — it signs the ES256 provider JWT, so nothing new is installed.

- Provider JWT: ES256 over `{iss: TEAM_ID, iat}` with `kid: KEY_ID`. Cache it;
  Apple requires it be refreshed no more often than every 20 minutes and no less
  than every 60. Reuse one HTTP/2 session across sends.
- Headers: `apns-push-type: alert`, `apns-priority: 10`, `apns-topic: <bundle
  id>`, `apns-collapse-id: <the existing tag>`.
- Payload: `aps.alert.{title, body}`, `sound`, `interruption-level`,
  `thread-id: <incidentNo>`, plus the existing `url` for the deep link. 4KB cap —
  our payloads are a few hundred bytes.
- `410 Unregistered` and `400 BadDeviceToken` → push onto the same `dead[]` array
  `sendTo()` already prunes with. Same lifecycle as a retired web endpoint.

### `feeder/push.ts`

One function changes. `sendTo()` currently calls `webpush.sendNotification` for
everything; it splits on `platform` and calls `apns.send()` for the iOS rows.
Every caller, every preference check, every auto-follow decision above it is
untouched — the alert-kind logic, the LGA/station matching, the duty-officer
suppression in `lib/units.ts` and the `PUSH_MAX_AGE_MIN` backfill guard all
apply to both transports because they run before the send.

The two alert kinds map onto sound and urgency:

| alert | tone | interruption level |
|---|---|---|
| **New incident**, device has narrowed to areas | pager tone, critical if granted | `critical` / `time-sensitive` |
| **New incident**, device on alert-everything | default | `active` |
| **Unit added** to a followed job | a second, quieter tone | `active` |

Alert-everything devices deliberately don't get the loud treatment: a device
that hasn't said what its patch is would be waking someone for every job in NSW.
This mirrors the rule `feeder/push.ts` already applies to auto-follow.

### Env (`.env.example`)

```
# ── APNs (native iOS app) ─────────────────────────────────────────────────────
# Key ID + team from the .p8 you download once from developer.apple.com.
# Leave blank to disable iOS push; web push and the board are unaffected.
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_BUNDLE_ID=net.wallboys.belterhub
APNS_KEY_P8=            # the PEM body, newlines as \n
APNS_HOST=api.push.apple.com   # api.sandbox.push.apple.com for dev builds
```

Sandbox vs production is the classic silent failure: a development build's token
is only valid against the sandbox host, and a TestFlight build's only against
production. A token minted by one and sent to the other returns
`BadDeviceToken`, which our pruning would happily read as "dead device" and
delete. So the client reports which environment it was built for, it's stored on
the row, and the feeder routes on it rather than on a single global host.

## Part 2 — the app

### Notification behaviour, precisely

- **Custom sounds** need no entitlement. Bundle the audio in the app; ≤30
  seconds; `.caf`, `.aiff` or `.wav`. `.wav` matters here — `afconvert` is
  Mac-only, so **on Windows, ship a `.wav`** and skip the conversion entirely.
  Registered through `expo-notifications`' config plugin `sounds` array, which
  copies them into the bundle at build time. The payload names the file.
- **Time Sensitive** (`interruption-level: time-sensitive`) breaks through Focus
  modes and shows on the lock screen for an hour. Entitlement
  `com.apple.developer.usernotifications.time-sensitive` is granted
  automatically — you tick it, no approval. This is the realistic default.
- **Critical Alerts** ignore the ringer switch, silent mode and every Focus, and
  set their own volume. The entitlement
  `com.apple.developer.usernotifications.critical-alerts` must be **requested
  from Apple by form and approved at their discretion**, typically for public
  safety, health and emergency response. A volunteer brigade turnout app is a
  fair case, but it is not ours to grant. **Request it in week 1** — approval
  takes weeks and the request is free. Also note the user is prompted separately
  for critical alerts (`UNAuthorizationOptions.criticalAlert`) and can revoke it
  in Settings.
- **Repeat until acknowledged** is ours to build, not Apple's to grant: the
  feeder re-sends a job's alert every N seconds until the device reports the
  card opened, collapsing onto the same `apns-collapse-id`. Worth having for
  turnouts, and only sane for a narrowed device.

Build for Time Sensitive; treat Critical as the upgrade that lands when it
lands. Nothing else in the plan depends on it.

### Screens, in the order they get built

1. **Enrol** — the code form, `components/AccessGate.tsx` almost verbatim. Token
   to `expo-secure-store` (Keychain) rather than localStorage; the same
   `/api/enroll` and `/api/session` calls; the same 45-minute refresh loop.
2. **Board** — WebView first, then native. The native version reuses
   `lib/parser.ts`, `lib/filter.ts`, `lib/lga.ts`, `lib/incident-merge.ts`,
   `lib/incident-messages.ts`, `lib/alert-prefs.ts`, `lib/units.ts`,
   `lib/nsw-lgas.ts`, `lib/frnsw-stations.ts`, `lib/standdown.ts` unchanged —
   about 1,500 lines of the hard-won part. Only `components/PagerBoard.tsx`'s
   view code is rewritten, as a `FlashList` of cards rather than a table: a
   946-line control-room table is the wrong shape for a phone and shouldn't be
   ported literally.
3. **Alerts / areas** — `components/AlertPrefs.tsx` rebuilt, plus the tone
   picker the web version can't have.
4. **Incident detail** — the modal as a screen, with a native map and a
   directions handoff to Apple Maps (`lib/maps.ts` already picks Apple on Apple
   platforms).
5. **Raw feed** — last. It's a debugging surface; the WebView is fine for it
   indefinitely.

### The bits that need care

- **Realtime in RN**: `@supabase/supabase-js` works, with
  `react-native-url-polyfill` and `detectSessionInUrl: false`. The websocket
  drops when the app backgrounds — that's correct and expected. Push is the
  alerting path; the socket is only for a board someone is looking at. Refetch on
  foreground rather than trusting the socket to have survived.
- **Device identity**: `lib/push-client.ts` hashes the invite token with
  `crypto.subtle`; on RN that becomes `expo-crypto`'s `digestStringAsync`. Same
  SHA-256, same hex, so a device that was enrolled as a PWA and is now an app
  reconciles onto one row and the old web subscription is pruned by the existing
  logic. Worth getting right — it's the difference between a clean migration and
  everyone being notified twice.
- **Registration**: `getDevicePushTokenAsync()`, not `getExpoPushTokenAsync()` —
  we want the raw APNs token. Needs a dev build; it does not work in Expo Go.
- **Deep links**: the `url` in the payload already carries `?incident=`. Map it
  to an app route so a tap opens the card, matching what `public/sw.js` does now.

## Part 3 — signing and distribution, from Windows

1. **Apple Developer Program** — US$99/year, individual or organisation. An
   organisation enrolment needs a D-U-N-S number and takes longer; an individual
   one is fine for this and can be moved later.
2. **Request the Critical Alerts entitlement** the same day. Free, slow.
3. **EAS Build** — `eas build --platform ios` builds on Apple's runners and
   manages certificates and profiles for you. No Xcode, no Mac, no keychain
   fiddling. `eas submit` uploads to App Store Connect.
4. **TestFlight** — internal testers (up to 100 people, 30 devices each, no
   review) is the right home for this. External testing would need Apple's
   review of each build's first submission.
5. **The 90-day expiry is the standing cost**: TestFlight builds stop launching
   after 90 days. A quarterly rebuild-and-push is a permanent chore. Put a
   calendar reminder on it — a brigade whose pager app expired last Tuesday is a
   worse outcome than not having shipped it.
6. If it ever needs to leave TestFlight: **Apple Business Manager custom app**
   distribution (unlisted, org-scoped) fits far better than the public App Store,
   which would want a demo code in the review notes and would still question a
   members-only utility under Guideline 4.2.

## Phases

Each phase is independently useful and independently shippable.

| # | Phase | Ships |
|---|---|---|
| 0 | Apple enrolment, entitlement request, `.p8` key, bundle ID | nothing visible; unblocks everything |
| 1 | `feeder/apns.ts`, `sendTo()` dispatch, schema columns, sandbox/production routing | web push unaffected, iOS ready to receive |
| 2 | Expo app: enrol screen, push registration, WebView board, bundled pager tone | **a phone that makes a pager noise for a real job** — the whole point |
| 3 | Tone picker + per-kind sounds + Time Sensitive; native alert-areas screen | the app is better than the PWA for anyone who's narrowed |
| 4 | Native board list + incident detail + native map | the WebView is gone from the daily path |
| 5 | Critical Alerts once granted; repeat-until-acknowledged | breaks silent mode |
| 6 | Later, and only if wanted: Live Activity for a running job; Apple Watch | lock-screen presence; both need Swift and the Watch needs a Mac |

Phase 2 is the deliverable. If the project stopped there it would already have
done the thing the PWA can't.

## Risks

- **Critical Alerts is refused.** Mitigated by design: Time Sensitive plus a
  custom tone is the shipped behaviour, and Critical is a payload flag flipped
  on later. It costs nothing to be turned down.
- **Sandbox/production token confusion** silently deletes good devices. Handled
  above by storing the environment per row, but it's the most likely way this
  goes wrong in week one.
- **The 90-day TestFlight expiry** is the most likely way it goes wrong in year
  one. Not a technical risk; an operational one.
- **Two clients to keep in step.** The web board and the app read the same API
  and share `lib/`, so drift is limited to view code — but the raw feed, the
  admin scripts and the Slack path stay web-only on purpose. Don't port them.
- **No Mac for anything Swift.** EAS compiles native code fine, but a Live
  Activity or Watch app can't be run in a simulator or debugged locally. That's
  why phase 6 is phase 6.

## What doesn't change

The feeder, all six sources, the parser, the merge rules, the Slack bot, the
`/raw` page, the invite-code access model, and the web board itself. This adds a
second client and a second push transport. It replaces nothing.
