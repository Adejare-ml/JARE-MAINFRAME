-- ============================================================================
-- 021_debt_monthly_payment.sql
--
-- One nullable column: what you plan to pay toward a loan each month, so
-- Debts.jsx can show a payoff date instead of just an outstanding balance.
-- No interest column alongside it -- these are personal loans, ajo and esusu,
-- not bank credit with a compounding rate, and adding one would be false
-- precision this app has no data to back up.
--
-- Idempotent; safe to re-run.
-- ============================================================================

alter table debts add column if not exists monthly_payment numeric;

alter table debts drop constraint if exists debts_monthly_payment_nonneg;
alter table debts add  constraint debts_monthly_payment_nonneg
  check (monthly_payment is null or monthly_payment >= 0);


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'debts' and column_name = 'monthly_payment'
  ) then
    raise exception 'debts.monthly_payment was not created';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'debts_monthly_payment_nonneg'
  ) then
    raise exception 'debts_monthly_payment_nonneg constraint was not created';
  end if;

  raise notice 'debts.monthly_payment verified';
end
$$;
