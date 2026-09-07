-- Apply to an existing schema before deploying the hardened app and feeder.
begin;

alter table public.incident_threads enable row level security;
revoke all on public.incident_threads from anon, authenticated;

-- Membership checks run as the owner so the credentials tables stay private.
create or replace function public.is_active_device()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.member_devices d
    join public.members m on m.id = d.member_id
    where d.id = (select auth.uid())
      and d.revoked_at is null and m.revoked_at is null
  );
$$;
revoke all on function public.is_active_device() from public, anon;
grant execute on function public.is_active_device() to authenticated, service_role;

drop policy if exists "allow_anon_read" on public.incidents;
drop policy if exists "allow_authenticated_read" on public.incidents;
create policy "allow_authenticated_read" on public.incidents
  for select to authenticated using ((select public.is_active_device()));
drop policy if exists "allow_authenticated_read_raw" on public.pager_messages;
create policy "allow_authenticated_read_raw" on public.pager_messages
  for select to authenticated using ((select public.is_active_device()));

-- Lock the member for the whole count/insert transaction. Every enrollment of
-- that member serializes here, across all Vercel instances.
create or replace function public.enroll_device(
  p_code text, p_device_token text, p_user_agent text
)
returns table(device_token text, error_code text)
language plpgsql
set search_path = ''
as $$
declare
  member_row public.members%rowtype;
  device_count bigint;
begin
  if p_code is null or length(p_code) < 1 or length(p_code) > 256
     or p_device_token is null or length(p_device_token) <> 32 then
    return query select null::text, 'invalid_code'::text;
    return;
  end if;

  select m.* into member_row from public.members m
    where lower(m.code) = lower(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g'))
    for update;
  if not found then
    select m.* into member_row from public.members m
      where m.invite_token = p_code for update;
  end if;
  if member_row.id is null or member_row.revoked_at is not null then
    return query select null::text, 'invalid_code'::text;
    return;
  end if;

  select count(*) into device_count from public.member_devices d
    where d.member_id = member_row.id and d.revoked_at is null;
  if device_count >= member_row.max_devices then
    return query select null::text, 'device_limit'::text;
    return;
  end if;

  insert into public.member_devices(member_id, device_token, user_agent, last_seen_at)
    values (member_row.id, p_device_token, left(p_user_agent, 400), now());
  return query select p_device_token, null::text;
end;
$$;
revoke all on function public.enroll_device(text, text, text) from public, anon, authenticated;
grant execute on function public.enroll_device(text, text, text) to service_role;

alter table public.push_subscriptions
  add column if not exists device_id uuid references public.member_devices(id) on delete cascade;

-- Preserve subscriptions that can be tied to an enrolled device. Unmatched
-- legacy rows remain for reconciliation; the feeder must not send to them.
update public.push_subscriptions s set device_id = d.id
  from public.member_devices d
  where s.device_id is null
    and s.device_key = encode(sha256(convert_to(d.device_token, 'UTF8')), 'hex');

create index if not exists push_subscriptions_device_id_idx
  on public.push_subscriptions(device_id) where device_id is not null;
create index if not exists incident_subscriptions_endpoint_idx
  on public.incident_subscriptions(endpoint);
create index if not exists incident_subscriptions_created_at_idx
  on public.incident_subscriptions(created_at);
create index if not exists pager_messages_status_received_at_hash_idx
  on public.pager_messages(status, received_at desc, hash desc);
create index if not exists pager_messages_incident_received_at_hash_idx
  on public.pager_messages(incident_no, received_at desc, hash desc)
  where incident_no is not null;

commit;
