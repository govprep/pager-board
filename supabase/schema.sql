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

-- Dropped first so re-running this file replaces the policy instead of erroring
-- with "policy already exists".
drop policy if exists "allow_authenticated_read" on public.incidents;

create policy "allow_authenticated_read"
  on public.incidents for select
  to authenticated
  using (true);

-- Enable Realtime on this table so the browser client gets instant pushes.
-- (In the Supabase dashboard: Table Editor → incidents → Realtime toggle ON)
-- Or via SQL. Wrapped so re-running this file is a no-op instead of erroring
-- with "relation is already member of publication" (42710).
do $$
begin
  alter publication supabase_realtime add table public.incidents;
exception
  when duplicate_object then null;  -- already published
end
$$;

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

-- Per-device notification preferences (see lib/alert-prefs.ts). Two independent,
-- OR'd lists, because the agencies page differently: RFS pages carry an address
-- whose LGA we match, FRNSW pages carry only a turnout number.
--   alert_all — true (the default) means every incident, ignoring both lists, so
--               devices subscribed before this shipped keep behaving as they did.
--   lgas      — LGA names as picked, e.g. {WINGECARRIBEE,"CENTRAL COAST"}.
--               Compared on a normalised key, so spelling variants still match.
--   stations  — FRNSW turnout numbers, leading zeros stripped, e.g. {428,385}.
alter table public.push_subscriptions
  add column if not exists alert_all boolean not null default true;
alter table public.push_subscriptions
  add column if not exists lgas      text[]  not null default '{}';
alter table public.push_subscriptions
  add column if not exists stations  text[]  not null default '{}';

-- Which physical device this subscription belongs to: a SHA-256 of the device's
-- durable invite token (never the token itself). Push services hand out a new
-- endpoint when they rotate a subscription, which used to leave the old row
-- behind — still enrolled, still on the preferences it had, quietly pushing
-- alongside the new one. Subscribing now carries the old row's preferences onto
-- the new endpoint and deletes it. Null on rows written before this shipped, and
-- on browsers that haven't enrolled (crypto.subtle needs a secure context).
alter table public.push_subscriptions
  add column if not exists device_key text;
create index if not exists push_subscriptions_device_key_idx
  on public.push_subscriptions (device_key) where device_key is not null;

-- When this device last picked its areas. Null means it has never opened the
-- picker — the alert_all above is a default it never asked for, not a choice —
-- so the board offers the picker once, and `npm run alerts` can tell the two
-- apart.
alter table public.push_subscriptions
  add column if not exists prefs_set_at timestamptz;

-- ── Stand-down flags ─────────────────────────────────────────────────────────
-- Set when a STOP / STAND DOWN / NNTA message arrives referencing this incident
-- number (see lib/standdown.ts). NULL = not stood down. Stamped on every row
-- sharing that incident_no, so the flag shows regardless of which row the
-- board picks as the group's representative.
alter table public.incidents
  add column if not exists stopped_at timestamptz;

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

-- ── Raw pager feed ───────────────────────────────────────────────────────────
-- Every line every source sees, BEFORE the board filter. `incidents` is a
-- heavily filtered view (numbered RFS/FRNSW jobs only); this table is the
-- firehose behind it — SES traffic, decode noise, test pages, stand-downs and
-- number-less pages all land here, tagged with what the pipeline did with them.
-- Powers the /raw page.
--
-- Deduplicated by content: `hash` is sha256 of the whitespace-normalised line,
-- so the same page arriving from pocsag + telegram + rfspager is ONE row
-- listing all three sources, with seen_count counting the repeats.
create table if not exists public.pager_messages (
  hash          text        primary key,               -- sha256(normalised raw)
  raw           text        not null,                  -- normalised line as it arrived
  status        text        not null default 'dropped', -- incident | standdown | dropped
  incident_no   text,                                  -- when the line carries one
  capcode       text,                                  -- pager capcode, e.g. 0125111
  agency        text,                                  -- FRNSW, Lower Hunter, …
  origin        text,                                  -- brigade/station, e.g. "251 Cardiff"
  sources       text[]      not null default '{}',     -- every feeder that reported it
  received_at   timestamptz not null default now(),    -- earliest known message time
  first_seen_at timestamptz not null default now(),    -- when we first recorded it
  last_seen_at  timestamptz not null default now(),    -- most recent re-report
  seen_count    int         not null default 1
);

-- Keyset pagination order for /raw (newest first, hash as the tiebreaker).
create index if not exists pager_messages_received_at_idx
  on public.pager_messages (received_at desc, hash desc);

-- Status filter chips on /raw.
create index if not exists pager_messages_status_idx
  on public.pager_messages (status);

-- Added after the first release, so existing installs get them too.
alter table public.pager_messages add column if not exists capcode text;
alter table public.pager_messages add column if not exists agency  text;
alter table public.pager_messages add column if not exists origin  text;

-- Members-only, exactly like incidents: reads require a verified session, and
-- writes come from the service role (feeder + API routes), which bypasses RLS.
alter table public.pager_messages enable row level security;

drop policy if exists "allow_authenticated_read_raw" on public.pager_messages;
create policy "allow_authenticated_read_raw"
  on public.pager_messages for select
  to authenticated
  using (true);

-- Live pushes to /raw, same as the board gets.
do $$
begin
  alter publication supabase_realtime add table public.pager_messages;
exception
  when duplicate_object then null;  -- already published
end
$$;

-- Upsert a batch of raw lines, merging duplicates instead of inserting them
-- twice. Called by lib/raw-feed.ts:recordRawMessages().
--
-- The batch is grouped by hash first, because ON CONFLICT DO UPDATE cannot
-- touch the same row twice in one statement (a batch legitimately contains the
-- same line more than once). On conflict we keep the EARLIEST received_at (the
-- message's real time), extend last_seen_at, union the sources, and let a later
-- 'incident' classification win over an earlier 'dropped' one.
create or replace function public.record_pager_messages(payload jsonb)
returns void
language sql
as $$
  insert into public.pager_messages
    (hash, raw, status, incident_no, capcode, agency, origin,
     sources, received_at, first_seen_at, last_seen_at, seen_count)
  select
    t.hash,
    min(t.raw),          -- identical within a hash group (raw is normalised)
    max(t.status),       -- text order happens to rank standdown > incident > dropped
    min(t.incident_no),  -- aggregates skip NULLs, so a number wins over none
    min(t.capcode),
    min(t.agency),
    min(t.origin),
    array_agg(distinct t.source),
    min(t.received_at),
    now(),
    max(t.received_at),
    count(*)::int
  from (
    select
      m ->> 'hash'        as hash,
      m ->> 'raw'         as raw,
      m ->> 'status'      as status,
      m ->> 'incident_no' as incident_no,
      m ->> 'capcode'     as capcode,
      m ->> 'agency'      as agency,
      m ->> 'origin'      as origin,
      m ->> 'source'      as source,
      coalesce((m ->> 'received_at')::timestamptz, now()) as received_at
    from jsonb_array_elements(payload) as m
  ) t
  where t.hash is not null and t.raw is not null
  group by t.hash
  on conflict (hash) do update set
    seen_count   = pager_messages.seen_count + excluded.seen_count,
    last_seen_at = greatest(pager_messages.last_seen_at, excluded.last_seen_at),
    received_at  = least(pager_messages.received_at, excluded.received_at),
    incident_no  = coalesce(pager_messages.incident_no, excluded.incident_no),
    -- Same line seen again, this time from a source that knows the brigade:
    -- fill the blanks, never overwrite what we already have.
    capcode      = coalesce(pager_messages.capcode, excluded.capcode),
    agency       = coalesce(pager_messages.agency,  excluded.agency),
    origin       = coalesce(pager_messages.origin,  excluded.origin),
    sources      = (
      select array_agg(distinct s)
      from unnest(pager_messages.sources || excluded.sources) as s
    ),
    status       = case
                     when pager_messages.status = 'dropped' then excluded.status
                     else pager_messages.status
                   end;
$$;

-- Only the feeder and the API routes (service role) may write the raw feed.
-- Without this, EXECUTE defaults to PUBLIC and any enrolled member could inject
-- rows through PostgREST's RPC endpoint.
revoke all on function public.record_pager_messages(jsonb) from public;
grant execute on function public.record_pager_messages(jsonb) to service_role;

-- One-time backfill so /raw isn't empty on the day this ships. Everything
-- already on the board is, by definition, a line that came over the air — we
-- just no longer have the lines that were filtered out before this table
-- existed. Those only start accumulating once the new feeder runs.
--
-- The hash expression here MUST match normalizeRaw()/rawHash() in
-- lib/raw-feed.ts, or backfilled rows won't dedupe against live ones.
insert into public.pager_messages
  (hash, raw, status, incident_no, sources, received_at, first_seen_at, last_seen_at, seen_count)
select
  encode(sha256(convert_to(btrim(regexp_replace(i.raw, '\s+', ' ', 'g')), 'UTF8')), 'hex'),
  btrim(regexp_replace(min(i.raw), '\s+', ' ', 'g')),
  'incident',
  min(i.incident_no),
  array['backfill'],
  min(i.received_at),
  now(),
  max(i.received_at),
  count(*)::int
from public.incidents i
where btrim(coalesce(i.raw, '')) <> ''
group by encode(sha256(convert_to(btrim(regexp_replace(i.raw, '\s+', ' ', 'g')), 'UTF8')), 'hex')
on conflict (hash) do nothing;
