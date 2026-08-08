-- ============================================================================
-- 004_debts.sql
--
-- Run after 003. Idempotent; safe to re-run.
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

  direction      text not null check (direction in ('owed_to_me', 'i_owe')),
  kind           text not null default 'loan' check (kind in ('loan', 'ajo', 'esusu')),
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
