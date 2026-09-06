# Moving the database to Sydney

The Supabase project lived in `ap-southeast-1` (Singapore). Everything that
talks to it is in Sydney: the feeder on the DigitalOcean droplet, and — once
`vercel.json` lands — the Vercel functions.

Measured from the feeder host against both projects, with gzip on (as any
browser sends):

| | Singapore | Sydney |
|---|---|---|
| bare REST round trip | 253ms | 54ms |
| `listIncidents(200)` — the board's page fetch | 240ms | **48ms** |
| `limit=1` (same shape, no payload) | 283ms | 46ms |

Flat across payload sizes, which is what tells you it's round-trip time rather
than transfer. Ingest pays it three times in series per page.

Measure with `Accept-Encoding: gzip`. Without it the 200-row page is ~120KB
uncompressed and transfer swamps the difference — that reads as a 194ms Sydney
fetch and badly understates the gain.

Supabase cannot change a project's region in place, so this is a new project and
a cutover. Free-plan projects are limited to two per account, but **paused
projects don't count**, which is what makes room for the new one.

## What actually has to move

Less than you'd expect, because of what this project *doesn't* use:

- **No Supabase Auth.** The gate is invite codes and device rows
  (`lib/access.ts`, `components/AccessGate.tsx`), so there's no auth schema.
- **No Storage, no Edge Functions.**
- **`public/sw.js` caches nothing** — no fetch handler, no Cache API. Installed
  PWAs pick up the new bundle on next load; nobody is stranded on a dead project.
- **Enrolment survives.** A device's durable credential is a row in
  `member_devices`, not anything Supabase issues. Phones don't re-enrol.
- **Push subscriptions survive.** VAPID keys live in the environment, not in
  Supabase.

So: seven tables, one function, the Realtime publication, and four environment
variables.

## The one thing that can break it

`/api/session` mints its **own HS256 token** signed with `SUPABASE_JWT_SECRET`
(`lib/access.ts`), and both PostgREST and Realtime are expected to accept it
because it carries `role=authenticated`. Supabase has since moved new projects
to asymmetric signing keys (ES256), with the legacy symmetric secret as a
fallback. If a new project has no usable HS256 secret, that path breaks — every
board read 401s and the Realtime socket never joins — and it breaks *after* the
environment is swapped.

`npm run migrate:verify` checks exactly this, against the new project, before
anything is cut over. Do not skip it.

## Progress

Steps 1–4 are **done** (2026-09-06). The new project
`bqznkxboeqshmexmiswh` is in `ap-southeast-2`, schema built, all 54,114 rows
loaded and verified, both new indexes confirmed in use (the board's page fetch
plans as an Index Only Scan with zero heap fetches). `migrate:verify` passes all
eleven checks, including the HS256 one — the new project accepts the board's own
minted tokens on both PostgREST and Realtime.

What remains is step 5 onwards: the environment swap, which needs Vercel.

## Runbook

Steps 1–5 are safe to run while the board is live. Only step 6 has downtime.

**1. Create the project.** Supabase dashboard → New project → region
**`ap-southeast-2` (Sydney)**. Then collect, from Settings:

| value | where |
|---|---|
| Project URL | Settings → API |
| `anon` / publishable key | Settings → API |
| `service_role` / secret key | Settings → API |
| JWT secret | Settings → JWT Keys (legacy secret; migrate the old one in if offered) |

**2. Build the schema.** Paste `supabase/schema.sql` into the new project's SQL
editor and run it. It's idempotent and creates the tables, indexes, RLS
policies, the Realtime publication and `record_pager_messages()`.

**3. Verify the new project can serve the board.**

```bash
TARGET_SUPABASE_URL=https://<new-ref>.supabase.co \
TARGET_SUPABASE_ANON_KEY=<anon> \
TARGET_SUPABASE_SERVICE_ROLE_KEY=<service_role> \
TARGET_SUPABASE_JWT_SECRET=<jwt secret> \
npm run migrate:verify
```

All checks must pass. If only the two HS256 checks fail, see the section above.

**4. Bulk copy, with the board still live.**

```bash
npm run migrate:dump -- /tmp/belter-dump
TARGET_SUPABASE_URL=… TARGET_SUPABASE_SERVICE_ROLE_KEY=… \
  npm run migrate:restore -- /tmp/belter-dump
```

The dump pages with a keyset cursor, so a feeder writing underneath it can't
cause skipped rows. The restore upserts and verifies counts against the dump's
manifest. **The dump contains device tokens, invite tokens and push
subscriptions — keep it local and delete it afterwards.**

**5. Stage the environment.** Set the four new values in Vercel (Project →
Settings → Environment Variables) but **don't redeploy yet**. Note that
`.env.local` on the droplet holds only what the feeder needs — the JWT secret
and VAPID private key live in Vercel only.

**6. Cut over.** Quiet hours; the sample shows 01:00–05:00 local is near-dead.

```bash
# a. stop the feeder so nothing new lands in Singapore
#    (kill the `npm run feeder` process on the droplet)
# b. final delta — same commands as step 4; upserts, so it only carries what changed
npm run migrate:dump -- /tmp/belter-delta
TARGET_… npm run migrate:restore -- /tmp/belter-delta
# c. point .env.local at the new project (URL, anon key, service role key)
# d. redeploy on Vercel so the new anon key is baked into the client bundle
# e. start the feeder
```

**7. Check.** Board loads, a page arrives live (Realtime), `/raw` populates,
`npm run alerts` lists the same devices, and the feeder logs `+N incident(s)`.

## Downtime and what it costs

Between 6a and 6e — a few minutes. Pages that arrive in that window are lost
from the live sockets, which have no replay; rfspager and PagerMon re-read their
own recent history on restart, so most of the gap backfills itself.

## Rolling back

Don't delete the Singapore project. Paused projects don't count against the free
limit, so it can sit there as a rollback: revert the environment variables,
redeploy, restart the feeder. Give it a week before deleting.
