-- Adds the hazards table (Live Traffic NSW) to an existing database. Safe to
-- re-run: every statement is `if not exists` or dropped-then-created.
--
-- Requires public.is_active_device(), created by 202609070001_security_hardening.
begin;

-- ---------------------------------------------------------------------------
-- Hazards — road and area conditions from Live Traffic NSW (lib/hazards.ts).
--
-- Kept apart from `incidents` on purpose. A hazard has no incident number, a
-- lifecycle measured in days, geometry that is usually a line rather than a
-- point, and must never reach a phone. The two tables are never joined at write
-- time; the map draws them as separate layers and the incident card correlates
-- them by distance at read time.
-- ---------------------------------------------------------------------------
create table if not exists public.hazards (
  id            text        primary key,           -- {source}|{external_id}
  source        text        not null,              -- "livetraffic"
  external_id   text        not null,              -- the publisher's own id
  category      text        not null,              -- incident | fire | flood | roadwork | majorevent | alpine
  headline      text        not null default '',
  display_name  text        not null default '',   -- the road(s), as published
  advice        text        not null default '',
  is_major      boolean     not null default false,
  suburb        text,
  coords        jsonb,                             -- { lng, lat } — see representativePoint()
  geometry      jsonb,                             -- GeoJSON as published
  roads         jsonb       not null default '[]',
  started_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  ended_at      timestamptz,                       -- set when it leaves the feed
  url           text,
  raw           jsonb       not null default '{}', -- the untouched feature
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- What the map asks for: the open hazards, newest first. Partial, because the
-- closed ones are history and nothing draws them.
create index if not exists hazards_open_idx
  on public.hazards (updated_at desc, id desc)
  where ended_at is null;

-- The writer's close pass filters on exactly this triple — see the note in
-- feeder/hazard-poster.ts about why absence is the end signal.
create index if not exists hazards_source_category_seen_idx
  on public.hazards (source, category, last_seen_at)
  where ended_at is null;

-- Members-only, exactly like incidents and pager_messages: reads require an
-- enrolled device, writes come from the service role (the feeder), which
-- bypasses RLS.
alter table public.hazards enable row level security;
revoke all on public.hazards from anon;

drop policy if exists "allow_authenticated_read_hazards" on public.hazards;
create policy "allow_authenticated_read_hazards"
  on public.hazards for select
  to authenticated
  using ((select public.is_active_device()));

commit;
