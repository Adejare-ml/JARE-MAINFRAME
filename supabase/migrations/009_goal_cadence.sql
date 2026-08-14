-- ============================================================================
-- 009_goal_cadence.sql
--
-- Run after 008. Idempotent; safe to re-run, including against a `goals` table
-- that already exists in an older shape.
--
-- Gives goals a cadence. Until now `period` was a column with exactly one value
-- in it: every read and every write in the app hardcodes 'daily', so the three
-- text boxes on Daily HQ were the entire concept of a plan. A goal you hold for
-- a month has nowhere to live, and nothing connects "save ₦150,000 by August"
-- to what you should do about it today.
--
-- After this: a monthly goal owns weekly goals, a weekly goal owns daily tasks,
-- and a goal that names a metric measures itself from the transactions the
-- Gmail sync already imports -- so the ones that can tick themselves do.
--
--
-- A note on why this file creates a table it did not invent.
--
-- `goals` has no CREATE TABLE anywhere in this repository. It was made by hand
-- in the Supabase dashboard, and 003_goal_slots.sql opens with a bare
-- `alter table goals`, assuming it into existence. That means a fresh Supabase
-- project cannot be built from this directory at all -- the migrations only
-- patch a schema they never define. It is the same class of gap as
-- `transactions_confidence_check`, a constraint that existed only in the live
-- database and silently rejected every insert the sync made for weeks.
--
-- This file cannot close that gap (transactions, wallets and user_settings are
-- still undeclared), but it refuses to widen it: the shape below is the shape
-- the app actually reads, so at least `goals` is now defined where it is used.
-- ============================================================================

create table if not exists goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid default auth.uid(),

  title        text not null,

  -- 'daily' | 'weekly' | 'monthly'. Constrained below as a named constraint so
  -- there is one definition whether this table is being created here or healed
  -- from the older shape.
  period       text not null default 'daily',
  target_date  date not null,

  -- Position within its (period, target_date). ZERO-BASED: 003 backfilled with
  -- `row_number() - 1` and Daily HQ writes the array index, so the three
  -- priorities are slots 0, 1 and 2. Anything assuming 1-based here will
  -- collide with real rows.
  slot         smallint,

  completed    boolean not null default false,
  created_at   timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- 1. Heal the existing shape
--
-- No-ops on a table this file just created. On the live one -- which predates
-- every migration here -- these are what make the rest of the file possible.
-- ---------------------------------------------------------------------------

alter table goals add column if not exists user_id     uuid    default auth.uid();
alter table goals add column if not exists period      text    not null default 'daily';
alter table goals add column if not exists slot        smallint;
alter table goals add column if not exists completed   boolean not null default false;
alter table goals add column if not exists created_at  timestamptz not null default now();


-- ---------------------------------------------------------------------------
-- 2. Cadence and measurement
-- ---------------------------------------------------------------------------

-- Lineage: a daily task points at the weekly goal that produced it, which
-- points at the monthly goal above it. Cascade, because a task derived from a
-- goal has no meaning once the goal is gone -- leaving orphans would put
-- untraceable items in tomorrow's list with nothing to explain them.
alter table goals add column if not exists parent_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'goals_parent_fk'
  ) then
    alter table goals
      add constraint goals_parent_fk
      foreign key (parent_id) references goals (id) on delete cascade;
  end if;
end
$$;

-- Derived or hand-typed. The UI needs this to say WHY a task is on the list --
-- a number the app computed has to be able to explain itself, and a task you
-- typed yourself should never be quietly rewritten by the generator.
alter table goals add column if not exists generated boolean not null default false;

-- What the goal is worth, and what measures it.
--   manual        -- a checkbox; the only kind that existed before
--   save_at_least -- credits into a category or wallet must reach target_amount
--   spend_under   -- debits in a category must stay below target_amount
alter table goals add column if not exists target_amount   numeric;
alter table goals add column if not exists metric          text not null default 'manual';
alter table goals add column if not exists metric_category text;
alter table goals add column if not exists metric_wallet_id uuid;

-- The wallets foreign key is added only if `wallets` is actually there.
-- Unconditional, it would make this file's success depend on a table no
-- migration in this directory declares -- and a migration that cannot run on a
-- fresh database blocks every migration after it, which is exactly how 004
-- stopped 005, 006 and 007 from ever reaching production.
do $$
begin
  if to_regclass('public.wallets') is not null
     and not exists (select 1 from pg_constraint where conname = 'goals_metric_wallet_fk')
  then
    alter table goals
      add constraint goals_metric_wallet_fk
      foreign key (metric_wallet_id) references wallets (id) on delete set null;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. Constraints
-- ---------------------------------------------------------------------------

alter table goals drop constraint if exists goals_period_valid;
alter table goals add  constraint goals_period_valid
  check (period in ('daily', 'weekly', 'monthly'));

alter table goals drop constraint if exists goals_metric_valid;
alter table goals add  constraint goals_metric_valid
  check (metric in ('manual', 'save_at_least', 'spend_under'));

-- A measured goal needs something to measure and a number to measure against.
-- Without this a 'save_at_least' goal with no target silently reads as 0/0 --
-- complete on creation, which is worse than an error.
alter table goals drop constraint if exists goals_metric_needs_target;
alter table goals add  constraint goals_metric_needs_target check (
  metric = 'manual'
  or (target_amount is not null and target_amount > 0
      and (metric_category is not null or metric_wallet_id is not null))
);

-- Slots 0-9 are yours, 10 and up belong to the generator. The generator upserts
-- on (period, target_date, slot), so without this partition a regenerated task
-- would overwrite whatever you had typed in slot 1.
alter table goals drop constraint if exists goals_generated_slot_range;
alter table goals add  constraint goals_generated_slot_range
  check (generated = false or slot >= 10);


-- ---------------------------------------------------------------------------
-- 4. Free the unique index before relying on it
--
-- 003 already creates goals_period_date_slot_uniq, but only if 003 ran -- and
-- on a database where it did not, a duplicate (period, target_date, slot) makes
-- `create unique index` fail and takes every later migration down with it. That
-- is precisely how 004 blocked 005 through 007.
--
-- Duplicates are RENUMBERED, not deleted. 008 could collapse duplicate retry
-- counters because they carried no independent meaning; these rows are
-- sentences a person typed about their own day, and no migration should throw
-- one away to make an index build. Extras move to the first free slot at or
-- above 100, out of the way of both the manual range and the generator.
-- ---------------------------------------------------------------------------

-- Slotless rows first. 003 backfills these, but only if 003 ran -- and a row
-- with a null slot is invisible to every upsert the app makes, because
-- `on conflict (period, target_date, slot)` cannot match NULL. The priority
-- stays on screen and a re-save silently inserts a second copy beside it.
--
-- Numbered from one past the highest slot already on that day, so this cannot
-- collide with rows 003 did number.
with slotless as (
  select g.id,
         coalesce(m.max_slot, -1) + row_number() over (
           partition by g.period, g.target_date
           order by g.created_at asc, g.id asc
         ) as new_slot
    from goals g
    left join (
      select period, target_date, max(slot) as max_slot
        from goals
       where slot is not null
       group by period, target_date
    ) m on m.period = g.period and m.target_date = g.target_date
   where g.slot is null
)
update goals g
   set slot = s.new_slot
  from slotless s
 where g.id = s.id;

with ranked as (
  select id,
         period,
         target_date,
         row_number() over (
           partition by period, target_date, slot
           order by created_at asc, id asc
         ) as dup_rank
    from goals
   where slot is not null
),
relocated as (
  select r.id,
         r.period,
         r.target_date,
         99 + row_number() over (
           partition by r.period, r.target_date
           order by r.id
         ) as new_slot
    from ranked r
   where r.dup_rank > 1
)
update goals g
   set slot = rl.new_slot
  from relocated rl
 where g.id = rl.id;

create unique index if not exists goals_period_date_slot_uniq
    on goals (period, target_date, slot);

-- "What belongs to this goal" and "what is on this date" are the two questions
-- every screen asks.
create index if not exists goals_parent_idx        on goals (parent_id);
create index if not exists goals_period_date_idx   on goals (period, target_date);


-- ---------------------------------------------------------------------------
-- 5. Row level security
--
-- Matches the policy shape used by every other table in this project today.
-- Tighten to (auth.uid() = user_id) alongside the others when multi-tenancy
-- lands -- the column is already here for that day.
-- ---------------------------------------------------------------------------

alter table goals enable row level security;

drop policy if exists goals_all_authenticated on goals;
create policy goals_all_authenticated on goals
  for all to authenticated using (true) with check (true);


-- ---------------------------------------------------------------------------
-- 6. Verify
--
-- 003 ended with a `select` for a human to read, which cannot fail a migration
-- and so cannot stop a broken one from shipping. These raise instead.
--
-- Both behaviours below are load-bearing: generation upserts on the slot key
-- every run, and deleting a goal has to take its derived tasks with it.
-- ---------------------------------------------------------------------------

do $$
declare
  parent_id_v uuid;
  child_count integer;
  slot_title  text;
begin
  -- Upsert on (period, target_date, slot) must UPDATE, not duplicate.
  insert into goals (title, period, target_date, slot)
  values ('__check_009__ first', 'daily', date '1990-01-01', 10);

  insert into goals (title, period, target_date, slot, generated)
  values ('__check_009__ second', 'daily', date '1990-01-01', 10, true)
  on conflict (period, target_date, slot) do update set title = excluded.title;

  select title into slot_title
    from goals where period = 'daily' and target_date = date '1990-01-01' and slot = 10;

  if slot_title <> '__check_009__ second' then
    raise exception 'upsert on (period, target_date, slot) did not update; the unique index is not arbitrating';
  end if;

  -- A generated task must not be allowed into the hand-typed slot range.
  begin
    insert into goals (title, period, target_date, slot, generated)
    values ('__check_009__ intruder', 'daily', date '1990-01-02', 1, true);
    raise exception 'generated slot range check did not fire';
  exception when check_violation then
    null;
  end;

  -- A measured goal with no target must be refused.
  begin
    insert into goals (title, period, target_date, slot, metric)
    values ('__check_009__ unmeasurable', 'monthly', date '1990-01-03', 0, 'save_at_least');
    raise exception 'metric-needs-target check did not fire';
  exception when check_violation then
    null;
  end;

  -- Deleting a parent must take its derived children with it.
  insert into goals (title, period, target_date, slot, metric, target_amount, metric_category)
  values ('__check_009__ parent', 'monthly', date '1990-01-04', 0, 'save_at_least', 1000, 'Savings')
  returning id into parent_id_v;

  insert into goals (title, period, target_date, slot, parent_id, generated)
  values ('__check_009__ child', 'weekly', date '1990-01-04', 10, parent_id_v, true);

  delete from goals where id = parent_id_v;

  select count(*) into child_count from goals where parent_id = parent_id_v;
  if child_count <> 0 then
    raise exception 'deleting a goal left % orphaned derived task(s)', child_count;
  end if;

  delete from goals where title like '__check_009__%';

  raise notice 'goals verified: slot upsert arbitrates, slot ranges hold, cascade removes derived tasks';
end
$$;

select 'goals' as table_name,
       count(*) filter (where period = 'daily')   as daily,
       count(*) filter (where period = 'weekly')  as weekly,
       count(*) filter (where period = 'monthly') as monthly
  from goals;
