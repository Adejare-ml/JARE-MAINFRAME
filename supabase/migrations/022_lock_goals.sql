-- ============================================================================
-- 022_lock_goals.sql
--
-- One boolean: a goal marked as money that is not meant to come out early --
-- PiggyVest's SafeLock next to Moniepoint's Flex Savings, as a single column
-- rather than a second table, because the only thing that differs is whether
-- the delete-confirmation on TargetCard warns you or not.
--
-- Idempotent; safe to re-run.
-- ============================================================================

alter table goals add column if not exists locked boolean not null default false;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'goals' and column_name = 'locked'
  ) then
    raise exception 'goals.locked was not created';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'goals'
       and column_name = 'locked' and is_nullable = 'NO'
  ) then
    raise exception 'goals.locked must be NOT NULL';
  end if;

  raise notice 'goals.locked verified';
end
$$;
