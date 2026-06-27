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

-- ── Members / access (invite code → up to N devices) ─────────────────────────
-- Two tables, both service-role only:
--   members        — one row per person. Holds a short, typeable `code` (and a
--                    long link token) plus max_devices (default 3). Revoke the
--                    member to boot all their devices at once.
--   member_devices — one row per enrolled device/context. Entering the code (or
--                    opening the link) at /api/enroll mints a device its own
--                    device_token, up to the member's max_devices. The browser
--                    stores that token and refreshes it via /api/session.
-- A code (not just the link) matters because an installed iOS PWA has its own
-- storage jar — the user re-enrols it by typing the code inside the PWA, which is
-- why one code must cover a few devices (Safari tab + PWA + spare).
create table if not exists public.members (
  id           uuid        primary key default gen_random_uuid(),
  label        text        not null default '',   -- who the code is for, e.g. "Jane S"
  code         text,                                -- short, typeable enrol code
  token        text,                                -- legacy (pre-split); kept nullable for backfill validity
  invite_token text,                                -- long link token (?invite=… / ?code=…)
  max_devices  int         not null default 3,      -- how many devices this code may enrol
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz                          -- non-null = access turned off (all devices)
);

-- One row per enrolled device/context. device_token is the browser's durable
-- credential; only /api/session accepts it. Cascades off the member.
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

-- Migration from the earlier single-row-per-device schema.
alter table public.members add column if not exists code         text;
alter table public.members add column if not exists invite_token text;
alter table public.members add column if not exists max_devices  int not null default 3;
alter table public.members add column if not exists token        text;  -- legacy, pre-split
alter table public.members add column if not exists device_token text;  -- legacy, pre-split
alter table public.members add column if not exists claimed_at   timestamptz; -- legacy
alter table public.members add column if not exists user_agent   text;  -- legacy
alter table public.members add column if not exists last_seen_at timestamptz; -- legacy (now on member_devices)
alter table public.members alter column token drop not null;

-- Move already-enrolled devices (old members.device_token) into member_devices.
insert into public.member_devices (member_id, device_token, user_agent, claimed_at, last_seen_at)
select id, coalesce(device_token, token), user_agent, coalesce(claimed_at, created_at), last_seen_at
from public.members
where coalesce(device_token, token) is not null
on conflict (device_token) do nothing;

-- Give every member a code if it lacks one (hex from a uuid — unambiguous chars).
update public.members
  set code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
where code is null;

create unique index if not exists members_code_key on public.members (lower(code));

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
