# Board access — single-use invite links

The board is members-only. Access is granted with **single-use invite links**:
each link enrols exactly one device, then it's spent and can't be used again.
Once a device is enrolled it's never prompted again (its credential lives in the
browser), so notifications and the board "just work" on that device.

## How it works

- Each person is one row in the `members` table with a lifecycle:
  **pending** (link issued) → **enrolled** (one device claimed it) → **revoked**.
- A link carries a one-time `invite_token`. The first device to open it calls
  `POST /api/enroll`, which atomically claims the link (sets `claimed_at`) and
  mints a separate per-device `device_token`. A second device opening the same
  link gets "invalid or already used".
- The browser stores the `device_token` (localStorage) and exchanges it at
  `POST /api/session` for a short-lived (1h) JWT signed with the Supabase legacy
  JWT secret. That JWT gates `GET /api/incidents` and Supabase Realtime, so the
  `incidents` table stays locked to anon while enrolled devices stream live.
- The two tokens are deliberately separate: `/api/enroll` only accepts
  `invite_token` (once); `/api/session` only accepts `device_token`. A leaked
  link can't be replayed into a session, and a claimed link is dead.

Enrollment is **per-origin and per-device** (localStorage). Always hand out links
on the canonical domain (`https://belter.cmssweb.com.au`); a device enrolled
there is not enrolled on `*.vercel.app`, and vice-versa.

## One-time setup

1. **JWT secret** — set `SUPABASE_JWT_SECRET` (Supabase → Settings → API → JWT
   Secret, the *legacy* secret) in:
   - `.env.local` (for the `access` CLI + local dev), and
   - **Vercel → Settings → Environment Variables** (Production), then redeploy.
   It's server-only; never `NEXT_PUBLIC_`.

2. **Schema** — run `supabase/schema.sql` in the Supabase SQL editor (idempotent).
   The members/access portion, standalone, is:

   ```sql
   alter table public.members add column if not exists invite_token text;
   alter table public.members add column if not exists device_token text;
   alter table public.members add column if not exists claimed_at   timestamptz;
   alter table public.members add column if not exists user_agent   text;
   alter table public.members alter column token drop not null;

   update public.members set
     invite_token = coalesce(invite_token, token),
     device_token = coalesce(device_token, token),
     claimed_at   = coalesce(claimed_at, created_at)
   where token is not null;

   create unique index if not exists members_invite_token_key on public.members(invite_token);
   create unique index if not exists members_device_token_key on public.members(device_token);
   ```

   This must be applied **before** the app deploy that reads `device_token`,
   or every device (including already-enrolled ones) is locked out until it runs.

3. **BOARD_URL** — set to the canonical host (`https://belter.cmssweb.com.au`) in
   `.env.local`. It drives the invite-link host and push-notification
   click-throughs. **Restart the feeder** after changing it (it reads
   `.env.local` once at startup; if a process manager exports `BOARD_URL`, update
   it there too).

## Managing access (admin CLI)

Run from your machine — it talks straight to Supabase with the service-role key,
so it works regardless of where the app is deployed.

```
npm run access new "Jane S"        # create a member, print their one-time link
npm run access list                # show everyone + status (pending / enrolled / REVOKED)
npm run access revoke <id|label>   # turn off access (effective within ~1h)
npm run access restore <id|label>  # turn it back on
```

- `new` prints `https://belter.cmssweb.com.au/?invite=<token>` — send it to the
  person; it works on the first device that opens it only.
- `list` shows the pending link for unclaimed members, and last-seen for enrolled
  ones.
- Revoking sets `revoked_at`; the device's next `/api/session` refresh is refused
  (≤1h), dropping it to the "Access removed" screen.

## Smoke test

1. `npm run access new "Test"` → open the link on a device → board loads.
2. Open the **same link** on a second device / incognito → "invalid or already
   used".
3. `npm run access revoke Test` → that device drops to "Access removed" within ~1h.
4. `npm run access list` → `Test` shows `enrolled`, then `REVOKED`.

## Troubleshooting

- **"Could not find the 'invite_token' column … in the schema cache"** — the
  schema migration hasn't been applied (or PostgREST hasn't reloaded). Run the
  migration above; add `notify pgrst, 'reload schema';` or wait ~30s.
- **"null value in column 'token' … violates not-null constraint"** — the legacy
  `token` column is still `NOT NULL`. Run
  `alter table public.members alter column token drop not null;`.
- **SQL editor "syntax error at end of input"** on a `do $$ … $$` block — the
  editor mangles dollar-quoting; use the plain `update` form above (no `do`
  block) instead.
- **`Assertion failed: … UV_HANDLE_CLOSING`** after a CLI command — harmless
  tsx/libuv exit noise on Windows; judge success by the message above it.

## Files

| Path | Role |
|------|------|
| `components/AccessGate.tsx` | gate: enroll via link, refresh session, lockout screens |
| `app/api/enroll/route.ts` | single-use claim of an invite link → device token |
| `app/api/session/route.ts` | device token → short-lived access JWT |
| `app/api/incidents/route.ts` | members-only (verifies the access token) |
| `lib/access.ts` | mint/verify access tokens (`jose`, `server-only`) |
| `scripts/access.ts` | the `npm run access` admin CLI |
| `supabase/schema.sql` | `members` table + migration + `authenticated`-only RLS |
