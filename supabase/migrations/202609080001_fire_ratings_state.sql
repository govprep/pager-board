-- Apply to an existing schema to enable the daily BOM Fire Danger Ratings push.
-- One row remembers the "Issued at …" line last summarised and pushed, so the
-- 16:20 and 16:30 cron runs stay idempotent and a restart never re-sends.
-- Server-only: the service role (scripts/fire-ratings.ts) reads and writes it;
-- the board never needs it, so RLS is on with no policy granted.
begin;

create table if not exists public.fire_ratings_state (
  id        boolean     primary key default true,
  issued    text        not null,
  pushed_at timestamptz not null default now(),
  constraint fire_ratings_state_singleton check (id)
);
alter table public.fire_ratings_state enable row level security;

commit;
