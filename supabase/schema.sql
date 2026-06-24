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
