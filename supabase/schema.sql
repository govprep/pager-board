-- Run this once in the Supabase SQL editor (or via supabase db push) to create
-- the incidents table and enable the Realtime feed.

create table if not exists public.incidents (
  id            text        primary key,          -- incident number (stable dedup key)
  incident_no   text        not null default '',
  type          text        not null default '',
  unit          text        not null default '',
  location      text        not null default '',
  coords        jsonb,                             -- { lng, lat } | null
  fields        jsonb       not null default '{}',
  received_at   timestamptz not null default now(),
  raw           text        not null default ''
);

-- Index for the default sort (newest first)
create index if not exists incidents_received_at_idx
  on public.incidents (received_at desc);

-- Row-level security: the board is members-only (SMS-OTP login), so reads
-- require a verified Supabase session. Anonymous sockets — including the
-- browser's Realtime subscription before sign-in — get nothing. Writes come
-- from the service role key (API routes + feeder), which bypasses RLS.
alter table public.incidents enable row level security;

-- Replaces the old public "allow_anon_read (using true)" policy. If you ran an
-- earlier schema, drop it first:  drop policy if exists "allow_anon_read" on public.incidents;
drop policy if exists "allow_anon_read" on public.incidents;

create policy "allow_authenticated_read"
  on public.incidents for select
  to authenticated
  using (true);

-- Enable Realtime on this table so the browser client gets instant pushes.
-- (In the Supabase dashboard: Table Editor → incidents → Realtime toggle ON)
-- Or via SQL:
alter publication supabase_realtime add table public.incidents;

-- ── Slack bot ────────────────────────────────────────────────────────────────
-- Marks when a page was posted to Slack. NULL = not yet posted; the feeder's
-- Slack step claims rows where this is NULL, posts them, then stamps the time.
alter table public.incidents
  add column if not exists slacked_at timestamptz;

-- One row per real-world incident (keyed by incident number) recording the Slack
-- thread its pages post into. The first page of a number creates the parent
-- message and stores its ts here; later pages reply into the same thread.
create table if not exists public.incident_threads (
  incident_no text        primary key,
  channel     text        not null,
  thread_ts   text        not null,
  created_at  timestamptz not null default now()
);

-- ── Members / access (single-use invite links) ───────────────────────────────
-- One row per person, with a lifecycle: pending → enrolled → (revoked).
--   pending   : created with an invite_token; the link is ?invite=<invite_token>.
--   enrolled  : a device redeemed the link (/api/enroll) — that single claim sets
--               claimed_at and mints a per-device device_token (stored in the
--               browser). The invite_token can never enrol a second device.
--   revoked   : revoked_at set; the device's next /api/session refresh is refused.
-- The two tokens are deliberately separate: /api/enroll only accepts invite_token
-- (once), /api/session only accepts device_token — so a leaked link can't be
-- replayed into a session, and a claimed link is dead. Service role only.
create table if not exists public.members (
  id           uuid        primary key default gen_random_uuid(),
  label        text        not null default '',   -- who the link is for, e.g. "Jane S"
  token        text,                                -- legacy (pre-split); kept nullable only so the backfill below is valid
  invite_token text        unique,                 -- one-time link secret (unusable once claimed)
  device_token text        unique,                 -- per-device secret, null until claimed
  claimed_at   timestamptz,                         -- when a device redeemed the link
  user_agent   text,                                -- claiming device, for the admin list
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz                          -- non-null = access turned off
);

-- Migration for an existing members table (earlier schema had a single, NOT NULL
-- `token`). Add the new columns, drop the old NOT NULL so new pending rows can
-- insert without it, then backfill so already-enrolled devices keep working:
-- their stored token becomes the device_token and the row counts as claimed.
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

alter table public.members enable row level security;
-- No anon policies: only the service role (API routes) reads/writes this.

-- ── Web push (PWA phone notifications) ───────────────────────────────────────
-- Marks when a page fired a push notification. NULL = not yet pushed; the
-- feeder's push step claims rows where this is NULL, sends, then stamps the time.
-- Same self-filtering pattern as slacked_at so re-upserts never double-notify.
alter table public.incidents
  add column if not exists pushed_at timestamptz;

-- One row per browser/device push subscription. Written by the subscribe API
-- (service role), read by the feeder to know who to notify. Endpoint is the
-- stable per-subscription URL the push service hands us.
create table if not exists public.push_subscriptions (
  endpoint   text        primary key,
  p256dh     text        not null,
  auth       text        not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
-- No anon policies: only the service role (API routes + feeder) touches this.

-- One row per (incident, device) the user has chosen to follow from the incident
-- modal. The feeder reads this to know who to notify when a new unit is added to
-- an already-known incident ("CMEASCR1 was added to RINGWOOD RD"). Cascades off
-- push_subscriptions so pruning a dead endpoint clears its follows too.
create table if not exists public.incident_subscriptions (
  incident_no text        not null,
  endpoint    text        not null references public.push_subscriptions(endpoint) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (incident_no, endpoint)
);

create index if not exists incident_subscriptions_incident_no_idx
  on public.incident_subscriptions (incident_no);

alter table public.incident_subscriptions enable row level security;
-- No anon policies: only the service role (API routes + feeder) touches this.
