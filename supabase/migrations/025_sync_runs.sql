-- ============================================================================
-- 025_sync_runs.sql
--
-- One row per scheduled-script run: which job, when, whether it did its
-- job, and a line about it. Every cron already opens a GitHub issue when it
-- fails, but nothing reaches the app -- so for five weeks in 2026 the app
-- kept drawing the shape of automation (a recap card, a net-worth line, a
-- calendar brief) with no way to say that none of it had run since 16
-- August. This is the table scripts/lib/assertProgress.mjs always called
-- "a separate piece".
--
-- Written by the scripts with the service key (user_id supplied by hand, as
-- everywhere), read by Settings → System. Same shape as 024: a small,
-- user-owned table, RLS `auth.uid() = user_id` from the first version.
-- Idempotent; safe to re-run.
-- ============================================================================

create table if not exists sync_runs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid(),
  job          text not null,
  started_at   timestamptz not null,
  finished_at  timestamptz not null default now(),
  ok           boolean not null,
  summary      text,
  created_at   timestamptz not null default now()
);

alter table sync_runs add column if not exists user_id      uuid not null default auth.uid();
alter table sync_runs add column if not exists job          text;
alter table sync_runs add column if not exists started_at   timestamptz;
alter table sync_runs add column if not exists finished_at  timestamptz not null default now();
alter table sync_runs add column if not exists ok           boolean;
alter table sync_runs add column if not exists summary      text;
alter table sync_runs add column if not exists created_at   timestamptz not null default now();

alter table sync_runs drop constraint if exists sync_runs_job_not_blank;
alter table sync_runs add  constraint sync_runs_job_not_blank
  check (length(trim(job)) > 0);

-- The one query the app makes: this user's latest runs, newest first.
create index if not exists sync_runs_user_finished_idx
  on sync_runs (user_id, finished_at desc);

alter table sync_runs enable row level security;

drop policy if exists sync_runs_all_authenticated on sync_runs;
create policy sync_runs_all_authenticated on sync_runs
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- Verify
--
-- Raising, in the style of 020 through 024.
-- ---------------------------------------------------------------------------

do $$
declare
  missing_col   text;
  policy_count  integer;
  test_user     uuid := gen_random_uuid();
  stored_count  integer;
begin
  select string_agg(c, ', ')
    into missing_col
    from unnest(array['user_id','job','started_at','finished_at','ok','summary','created_at']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'sync_runs' and column_name = c
   );

  if missing_col is not null then
    raise exception 'sync_runs is missing column(s): %', missing_col;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'sync_runs'
       and column_name = 'user_id' and is_nullable = 'NO'
  ) then
    raise exception 'sync_runs.user_id must be NOT NULL';
  end if;

  select count(*) into policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'sync_runs'
     and qual like '%user_id%' and with_check like '%user_id%';

  if policy_count <> 1 then
    raise exception 'expected exactly one owner-scoped policy on sync_runs, found %', policy_count;
  end if;

  insert into sync_runs (user_id, job, started_at, ok, summary)
  values (test_user, 'gmail-sync', now() - interval '1 minute', true, '3 new'),
         (test_user, 'gmail-sync', now(), false, 'invalid_grant');

  select count(*) into stored_count from sync_runs where user_id = test_user;
  if stored_count <> 2 then
    raise exception 'sync_runs kept % row(s) for two runs; runs must accumulate, not replace', stored_count;
  end if;

  begin
    insert into sync_runs (user_id, job, started_at, ok) values (test_user, '   ', now(), true);
    raise exception 'sync_runs_job_not_blank accepted a blank job';
  exception when check_violation then
    null;
  end;

  delete from sync_runs where user_id = test_user;

  raise notice 'sync_runs verified: owned, one row per run, RLS on from the start';
end
$$;
