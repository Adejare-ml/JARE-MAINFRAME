-- ============================================================================
-- 018_wallet_snapshots.sql
--
-- One row per day, capturing every wallet's balance -- the primitive a net
-- worth trend needs and nothing in this schema has ever recorded. Every
-- table so far only ever holds the *current* balance; the moment it changes,
-- what it used to be is gone. This is the first table in the app whose whole
-- job is to remember, not to reflect.
--
-- Idempotent; safe to re-run. RLS enabled with `auth.uid() = user_id` from
-- the first version -- 013 through 017 exist because tables kept arriving
-- without that, and this one does not get to repeat it.
-- ============================================================================

create table if not exists wallet_snapshots (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  snapshot_date  date not null,
  -- The sum, so a trend line does not require sending every row's by_wallet
  -- back down to compute it client-side.
  total_balance  numeric not null,
  -- {wallet_id: balance}, so a later "which wallet moved" question is
  -- answerable without a second table, at the cost this table is trusted to
  -- be read, never joined on -- there is nothing here to join.
  by_wallet      jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

alter table wallet_snapshots add column if not exists user_id       uuid not null default auth.uid();
alter table wallet_snapshots add column if not exists snapshot_date date;
alter table wallet_snapshots add column if not exists total_balance numeric;
alter table wallet_snapshots add column if not exists by_wallet     jsonb not null default '{}'::jsonb;
alter table wallet_snapshots add column if not exists created_at    timestamptz not null default now();

-- One snapshot per day. A second run the same day (a retried workflow,
-- a manual re-trigger) upserts in place rather than doubling the row --
-- the script issues an upsert on this constraint, not an insert.
create unique index if not exists wallet_snapshots_user_date_uniq
  on wallet_snapshots (user_id, snapshot_date);

alter table wallet_snapshots enable row level security;

drop policy if exists wallet_snapshots_all_authenticated on wallet_snapshots;
create policy wallet_snapshots_all_authenticated on wallet_snapshots
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  missing_col   text;
  policy_count  integer;
begin
  select string_agg(c, ', ')
    into missing_col
    from unnest(array['user_id','snapshot_date','total_balance','by_wallet','created_at']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'wallet_snapshots' and column_name = c
   );

  if missing_col is not null then
    raise exception 'wallet_snapshots is missing column(s): %', missing_col;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'wallet_snapshots'
       and column_name = 'user_id' and is_nullable = 'NO'
  ) then
    raise exception 'wallet_snapshots.user_id must be NOT NULL -- 017 exists precisely so a new table does not reopen the gap it closed';
  end if;

  select count(*) into policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'wallet_snapshots'
     and qual like '%user_id%' and with_check like '%user_id%';

  if policy_count <> 1 then
    raise exception 'expected exactly one owner-scoped policy on wallet_snapshots, found %', policy_count;
  end if;

  raise notice 'wallet_snapshots verified: owned, unique per day, RLS on from the start';
end
$$;
