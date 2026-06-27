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

-- Row-level security: allow anonymous reads, block anonymous writes.
-- Writes come from the service role key (API routes), which bypasses RLS.
alter table public.incidents enable row level security;

create policy "allow_anon_read"
  on public.incidents for select
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
