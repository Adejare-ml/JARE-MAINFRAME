-- ============================================================================
-- 031_push_subscriptions.sql
--
-- Run after 030. Idempotent; safe to re-run.
--
-- One row per device that asked for the morning reminder: the browser's
-- push endpoint and the two keys web-push needs to encrypt to it. Written
-- by the app from Settings -> Reminders, read by scripts/remind.mjs with
-- the service key. A device that turns reminders off deletes its row; an
-- endpoint the push service reports gone (404/410) is deleted by the
-- script; anything else that fails is stamped, not deleted, so a flaky
-- morning does not silently unsubscribe a phone.
--
-- Same shape as 025: small, user-owned, RLS `auth.uid() = user_id` from
-- the first version.
-- ============================================================================

create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid(),
  endpoint     text not null,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  failed_at    timestamptz
);

alter table push_subscriptions add column if not exists user_id      uuid not null default auth.uid();
alter table push_subscriptions add column if not exists endpoint     text;
alter table push_subscriptions add column if not exists p256dh       text;
alter table push_subscriptions add column if not exists auth         text;
alter table push_subscriptions add column if not exists user_agent   text;
alter table push_subscriptions add column if not exists created_at   timestamptz not null default now();
alter table push_subscriptions add column if not exists last_used_at timestamptz;
alter table push_subscriptions add column if not exists failed_at    timestamptz;

alter table push_subscriptions drop constraint if exists push_subscriptions_endpoint_not_blank;
alter table push_subscriptions add  constraint push_subscriptions_endpoint_not_blank
  check (length(trim(endpoint)) > 0);

alter table push_subscriptions drop constraint if exists push_subscriptions_keys_not_blank;
alter table push_subscriptions add  constraint push_subscriptions_keys_not_blank
  check (length(trim(p256dh)) > 0 and length(trim(auth)) > 0);

-- Dedupe before the unique index, newest row wins: the browser re-subscribes
-- with fresh keys for the same endpoint, and the fresh keys are the ones
-- that decrypt.
delete from push_subscriptions older
 using push_subscriptions newer
 where older.user_id = newer.user_id
   and older.endpoint = newer.endpoint
   and (older.created_at < newer.created_at
        or (older.created_at = newer.created_at and older.id < newer.id));

-- What the app's upsert conflicts on (user_id, endpoint).
create unique index if not exists push_subscriptions_user_endpoint_idx
  on push_subscriptions (user_id, endpoint);

alter table push_subscriptions enable row level security;

drop policy if exists push_subscriptions_all_authenticated on push_subscriptions;
create policy push_subscriptions_all_authenticated on push_subscriptions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  missing_col  text;
  policy_count integer;
  test_user    uuid := gen_random_uuid();
  dup_refused  boolean := false;
begin
  select string_agg(c, ', ')
    into missing_col
    from unnest(array['user_id','endpoint','p256dh','auth','user_agent','created_at','last_used_at','failed_at']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'push_subscriptions' and column_name = c
   );
  if missing_col is not null then
    raise exception 'push_subscriptions is missing column(s): %', missing_col;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'push_subscriptions'
       and column_name = 'user_id' and is_nullable = 'NO'
  ) then
    raise exception 'push_subscriptions.user_id must be NOT NULL';
  end if;

  select count(*) into policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'push_subscriptions'
     and qual like '%user_id%' and with_check like '%user_id%';
  if policy_count <> 1 then
    raise exception 'expected exactly one owner-scoped policy on push_subscriptions, found %', policy_count;
  end if;

  insert into push_subscriptions (user_id, endpoint, p256dh, auth)
  values (test_user, 'https://push.example/one', 'k1', 'a1');
  begin
    insert into push_subscriptions (user_id, endpoint, p256dh, auth)
    values (test_user, 'https://push.example/one', 'k2', 'a2');
  exception when unique_violation then
    dup_refused := true;
  end;

  begin
    insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (test_user, '  ', 'k', 'a');
    raise exception 'push_subscriptions accepted a blank endpoint';
  exception when check_violation then
    null;
  end;

  delete from push_subscriptions where user_id = test_user;

  if not dup_refused then
    raise exception 'push_subscriptions accepted the same endpoint twice for one user';
  end if;

  raise notice 'push_subscriptions verified: owned, one row per device, RLS on from the start';
end
$$;
