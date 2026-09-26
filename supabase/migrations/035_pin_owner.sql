-- ============================================================================
-- 035_pin_owner.sql
--
-- Run after 034. Idempotent; safe to re-run.
--
-- 034 let jare_sole_owner() honour a pinned owner in a database setting.
-- Supabase refuses `alter database ... set` and `alter role ... set` for a
-- custom setting ("permission denied to set parameter"), so the pin has to
-- live in a table. One row, no policies (RLS on, so only the service role
-- and postgres can read it), filled automatically while the project still
-- has exactly one account. From then on a second account -- a test login,
-- a stray sign-up -- changes nothing: the bank-alert ingestion and the run
-- record keep writing to the owner they were pinned to.
--
-- The setting still works for a one-off (`set local jare.owner = ...`, as
-- 014 documents); the table wins when both are present.
-- ============================================================================

create table if not exists jare_owner (
  -- The constant key makes "at most one row" a primary-key fact.
  one      boolean primary key default true check (one),
  user_id  uuid not null references auth.users(id) on delete cascade,
  pinned_at timestamptz not null default now()
);

alter table jare_owner enable row level security;
-- No policies on purpose: nothing in the app needs to read this.

revoke all on table jare_owner from public, anon, authenticated;

insert into jare_owner (user_id)
select id from auth.users
 where (select count(*) from auth.users) = 1
on conflict (one) do nothing;

create or replace function jare_sole_owner() returns uuid
language plpgsql
stable
as $$
declare
  pinned_text text := nullif(current_setting('jare.owner', true), '');
  pinned      uuid;
  owner_id    uuid;
  user_count  integer;
begin
  select user_id into pinned from jare_owner limit 1;
  if pinned is not null then
    return pinned;
  end if;

  if pinned_text is not null then
    begin
      pinned := pinned_text::uuid;
    exception when others then
      raise exception 'jare.owner is set but is not a uuid: %', pinned_text;
    end;
    if not exists (select 1 from auth.users where id = pinned) then
      raise exception 'jare.owner names % but no such account exists', pinned;
    end if;
    return pinned;
  end if;

  select count(*) into user_count from auth.users;
  if user_count = 0 then
    raise exception 'auth.users is empty; sign in to the app once first';
  elsif user_count > 1 then
    raise exception 'auth.users holds % accounts, so the owner is ambiguous. Pin it once: insert into jare_owner (user_id) values (''<uuid>'');', user_count;
  end if;
  select id into owner_id from auth.users;
  return owner_id;
end
$$;

revoke execute on function jare_sole_owner() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  pinned uuid;
begin
  if (select count(*) from auth.users) = 1 then
    select user_id into pinned from jare_owner;
    if pinned is null then raise exception 'the single account was not pinned'; end if;
    if pinned <> (select id from auth.users) then raise exception 'jare_owner names the wrong account'; end if;
    if jare_sole_owner() <> pinned then raise exception 'jare_sole_owner() ignores the pin'; end if;
  end if;
  if (select count(*) from jare_owner) > 1 then raise exception 'jare_owner holds more than one row'; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'jare_owner') then
    raise exception 'jare_owner must have no policies';
  end if;
  raise notice 'owner pinned: jare_sole_owner() reads jare_owner first';
end
$$;
