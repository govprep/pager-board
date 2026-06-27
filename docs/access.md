# Board access — invite codes (a few devices each)

The board is members-only. Each person gets a short **access code** (and a link
that carries it). Entering the code enrols a device, which then never asks again
(its credential lives in that browser). One code covers up to **3 devices** so a
person can enrol their Safari tab, their installed home-screen PWA, and a spare.

## Why a code, not just a link

An installed iOS PWA (Add to Home Screen) gets its **own storage jar**, separate
from the Safari tab — and push notifications only work in the installed PWA. You
can't deep-link a tap straight into an installed PWA, so the reliable flow on a
phone is: **add to home screen first, then open the app and type the code.** The
3-device allowance means using the code in both Safari and the PWA is fine.

## How it works

- `members` = one row per person: a short `code`, a `max_devices` cap (default 3),
  and `revoked_at`. Revoke the member to boot all their devices at once.
- `member_devices` = one row per enrolled device. Entering the code at
  `POST /api/enroll` mints that device its own `device_token` (up to the cap),
  stored in the browser.
- The browser exchanges `device_token` at `POST /api/session` for a short-lived
  (1h) JWT signed with the Supabase legacy JWT secret. That JWT gates
  `GET /api/incidents` and Supabase Realtime, so the `incidents` table stays
  locked to anon while enrolled devices stream live.
- `/api/enroll` only accepts the code/link; `/api/session` only accepts a
  `device_token` — a leaked code can't be replayed into a session.

Enrolment is per-origin (localStorage). Always use the canonical domain
`https://belter.cmssweb.com.au`.

## One-time setup

1. **JWT secret** — `SUPABASE_JWT_SECRET` (Supabase → Settings → API → JWT Secret,
   the *legacy* secret) in `.env.local` **and** Vercel → Environment Variables
   (Production), then redeploy. Server-only; never `NEXT_PUBLIC_`.

2. **Schema** — run `supabase/schema.sql` (idempotent). The access portion,
   standalone (plain SQL, no `do $$` blocks):

   ```sql
   create table if not exists public.member_devices (
     id           uuid        primary key default gen_random_uuid(),
     member_id    uuid        not null references public.members(id) on delete cascade,
     device_token text        not null unique,
     user_agent   text,
     claimed_at   timestamptz not null default now(),
     last_seen_at timestamptz,
     revoked_at   timestamptz
   );
   alter table public.member_devices enable row level security;
   create index if not exists member_devices_member_id_idx on public.member_devices (member_id);

   alter table public.members add column if not exists code        text;
   alter table public.members add column if not exists max_devices int not null default 3;

   -- Move already-enrolled devices into member_devices.
   insert into public.member_devices (member_id, device_token, user_agent, claimed_at, last_seen_at)
   select id, coalesce(device_token, token), user_agent, coalesce(claimed_at, created_at), last_seen_at
   from public.members
   where coalesce(device_token, token) is not null
   on conflict (device_token) do nothing;

   -- Give every member a code if it lacks one.
   update public.members
     set code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
   where code is null;

   create unique index if not exists members_code_key on public.members (lower(code));
   ```

   Apply this **before** the deploy that reads `member_devices`, or enrolled
   devices are locked out until it runs.

3. **BOARD_URL** — canonical host in `.env.local`; drives link host + push
   click-throughs. **Restart the feeder** after changing it.

## Managing access (admin CLI)

```
npm run access new "Jane S"        # create a member, print code + link
npm run access list                # members, devices used/max, status
npm run access revoke <id|label>   # turn off a member (boots all its devices, ≤1h)
npm run access restore <id|label>  # turn it back on
```

- `new` prints a `CODE` and `https://belter.cmssweb.com.au/?code=CODE`. Send
  either. Tell phone users to add to home screen first, then type the code.
- `list` shows `devices 1/3` usage per member.
- Revoking sets `revoked_at`; every device's next `/api/session` refresh is
  refused within ~1h.

## Smoke test

1. `npm run access new "Test"` → enter the code in the app → board loads.
2. Enter the same code on two more devices → works; a 4th → "already used on the
   maximum number of devices".
3. `npm run access revoke Test` → all those devices drop to the code screen ≤1h.

## Troubleshooting

- **"Could not find the 'code'/'member_devices' …"** — schema migration not
  applied (or PostgREST cache stale). Run the migration; add
  `notify pgrst, 'reload schema';` or wait ~30s.
- **SQL editor "syntax error at end of input"** on `do $$ … $$` — the editor
  mangles dollar-quoting; the migration above is plain SQL with no such blocks.
- **`Assertion failed: … UV_HANDLE_CLOSING`** after a CLI command — harmless
  tsx/libuv exit noise on Windows; judge success by the line above it.

## Files

| Path | Role |
|------|------|
| `components/AccessGate.tsx` | gate: code-entry form, enrol, refresh session |
| `app/api/enroll/route.ts` | code → device token (enforces the device cap) |
| `app/api/session/route.ts` | device token → short-lived access JWT |
| `app/api/incidents/route.ts` | members-only (verifies the access token) |
| `lib/access.ts` | mint/verify access tokens (`jose`, `server-only`) |
| `scripts/access.ts` | the `npm run access` admin CLI |
| `supabase/schema.sql` | `members` + `member_devices` + `authenticated`-only RLS |
