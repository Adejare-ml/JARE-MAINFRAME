-- ============================================================================
-- 004_debts.sql
--
-- Run after 003. Idempotent; safe to re-run, including against a `debts` table
-- that already exists in the wrong shape.
--
-- That last clause was not true until it had to be. `create table if not
-- exists` skips silently when something by that name is already there, so a
-- half-built `debts` left over from an earlier attempt sailed past creation and
-- then failed on the first constraint referencing a column it never had --
-- `column "kind" does not exist`, forever, on every re-run. Because the
-- migration runner applies this directory in order, that single error also
-- stopped 005, 006 and 007 from ever reaching the database, which is how the
-- app came to be querying a column that did not exist.
--
-- So the shape is healed before it is constrained.
--
-- Money owed in both directions, with ajo and esusu as first-class kinds
-- rather than an afterthought.
--
-- 'Ajo / Esusu' is already a spending category, so a contribution currently
-- logs as an ordinary expense with no counterparty, no cycle position and no
-- payout date. Cycle position in particular cannot be derived from the ledger:
-- twelve identical ₦20,000 debits tell you nothing about whether the payout is
-- next month or in September. That is the gap this table fills.
-- ============================================================================

create table if not exists debts (
  id             uuid primary key default gen_random_uuid(),

  -- Included from day one even though RLS does not use it yet. Adding an
  -- ownership column to a populated table later is a migration plus a
  -- backfill plus a policy rewrite; adding it now is one line.
  user_id        uuid default auth.uid(),

  -- The value checks for `direction` and `kind` live below as named
  -- constraints rather than inline, so there is exactly one definition of each
  -- and it applies whether this table is being created here or healed from an
  -- older shape.
  direction      text not null,
  kind           text not null default 'loan',
  counterparty   text not null,

  -- Loans: the sum owed and how much has been settled so far.
  principal      numeric not null default 0,
  amount_paid    numeric not null default 0,

  -- Rotating savings. contribution is per round; cycle_position is which round
  -- you are in (1-based); payout_date is when the pot comes to you.
  cycle_size     integer,
  cycle_position integer,
  contribution   numeric,

  due_date       date,
  payout_date    date,
  settled        boolean not null default false,
  notes          text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- Heal the shape before constraining it
--
-- No-ops on a table this file just created. On one that predates it, these are
-- what make every statement below possible at all. `add column ... not null
-- default X` is safe on a populated table -- Postgres records the default
-- rather than rewriting every row -- so this is non-destructive either way.
-- ---------------------------------------------------------------------------

alter table debts add column if not exists user_id        uuid    default auth.uid();
alter table debts add column if not exists kind           text    not null default 'loan';
alter table debts add column if not exists principal      numeric not null default 0;
alter table debts add column if not exists amount_paid    numeric not null default 0;
alter table debts add column if not exists cycle_size     integer;
alter table debts add column if not exists cycle_position integer;
alter table debts add column if not exists contribution   numeric;
alter table debts add column if not exists due_date       date;
alter table debts add column if not exists payout_date    date;
alter table debts add column if not exists settled        boolean not null default false;
alter table debts add column if not exists notes          text;
alter table debts add column if not exists created_at     timestamptz not null default now();
alter table debts add column if not exists updated_at     timestamptz not null default now();

-- These two are NOT NULL with no sensible default: there is no neutral
-- direction and no neutral counterparty. Added nullable, then tightened only
-- once the existing rows are known to satisfy it -- so a populated legacy table
-- degrades to a warning rather than aborting the run and, with it, every later
-- migration in the directory.
alter table debts add column if not exists direction    text;
alter table debts add column if not exists counterparty text;

do $$
begin
  if exists (select 1 from debts where direction is null or counterparty is null) then
    raise warning 'debts has rows with a null direction or counterparty, so those columns stay nullable. Fill them in and re-run this migration.';
  else
    alter table debts alter column direction    set not null;
    alter table debts alter column counterparty set not null;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

alter table debts drop constraint if exists debts_direction_valid;
alter table debts add  constraint debts_direction_valid
  check (direction in ('owed_to_me', 'i_owe'));

alter table debts drop constraint if exists debts_kind_valid;
alter table debts add  constraint debts_kind_valid
  check (kind in ('loan', 'ajo', 'esusu'));

-- A rotating cycle only makes sense with a size, and the position must sit
-- inside it. Loans have neither.
alter table debts drop constraint if exists debts_cycle_coherent;
alter table debts add  constraint debts_cycle_coherent check (
  kind = 'loan'
  or cycle_size is null
  or (cycle_size > 0 and (cycle_position is null or cycle_position between 1 and cycle_size))
);

alter table debts drop constraint if exists debts_amounts_nonneg;
alter table debts add  constraint debts_amounts_nonneg check (
  principal >= 0 and amount_paid >= 0 and (contribution is null or contribution >= 0)
);

-- Daily HQ asks "what is due soon", so both dates are indexed for open debts.
create index if not exists debts_open_due_idx     on debts (due_date)    where settled = false;
create index if not exists debts_open_payout_idx  on debts (payout_date) where settled = false;

alter table debts enable row level security;

-- Matches the policy shape used by every other table in this project today.
-- Tighten to (auth.uid() = user_id) when multi-tenancy lands.
drop policy if exists debts_all_authenticated on debts;
create policy debts_all_authenticated on debts
  for all to authenticated using (true) with check (true);


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
begin
  -- A 12-month ajo at position 13 must be rejected.
  begin
    insert into debts (direction, kind, counterparty, cycle_size, cycle_position)
    values ('owed_to_me', 'ajo', '__check__', 12, 13);
    raise exception 'cycle coherence check did not fire';
  exception when check_violation then
    null;
  end;

  raise notice 'debts table verified: cycle constraints active';
end
$$;

select 'debts' as table_name, count(*) as rows from debts;
