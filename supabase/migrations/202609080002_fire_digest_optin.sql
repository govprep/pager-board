-- Apply to an existing schema to make the daily fire danger push opt-in.
-- Adds a per-device flag; default false, so after this ships the digest reaches
-- only devices that turn it on (feeder/push.ts:broadcast filters on it). Its own
-- setting, independent of the incident area preferences.
begin;

alter table public.push_subscriptions
  add column if not exists fire_digest boolean not null default false;

commit;
