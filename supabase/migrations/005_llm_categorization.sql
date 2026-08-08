-- ============================================================================
-- 005_llm_categorization.sql
--
-- Run after 004. Idempotent; safe to re-run.
--
-- Two additions for automatic categorization:
--   1. Somewhere to store the model's reasoning, so a transaction awaiting
--      review explains itself instead of asking you to work it out again.
--   2. A record of the categories you corrected by hand, fed back to the model
--      as examples so it learns how you actually file things.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Why the app thinks this transaction is what it says
--
-- One plain sentence per transaction, written by the model from the email's own
-- details. Shown on unreviewed rows only; on a settled row it is noise.
-- ---------------------------------------------------------------------------

alter table transactions add column if not exists explanation text;


-- ---------------------------------------------------------------------------
-- 2. Categories you corrected
--
-- Written whenever a manual edit changes a category to something other than
-- what the model chose. The 30 most recent are shown to the model as examples
-- on every categorization request, so a counterparty you have filed once starts
-- being filed that way automatically.
--
-- Deliberately append-only and denormalised: it is a log of decisions, not a
-- mapping table. Two corrections for the same recipient are both kept, and the
-- more recent one wins simply by being nearer the top of the list.
-- ---------------------------------------------------------------------------

create table if not exists category_corrections (
  id                  uuid default gen_random_uuid() primary key,
  recipient           text,
  description_snippet text,
  corrected_category  text not null,
  created_at          timestamptz default now()
);

alter table category_corrections enable row level security;

-- Matches the policy shape used by every other table in this project today.
-- Tighten alongside the rest when multi-tenancy lands.
drop policy if exists "authenticated access" on category_corrections;
create policy "authenticated access" on category_corrections
  for all to authenticated using (true) with check (true);

-- The only read is "the most recent N", so that is the only index needed.
create index if not exists category_corrections_recent_idx
  on category_corrections (created_at desc);


-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
begin
  insert into category_corrections (recipient, description_snippet, corrected_category)
  values ('__migration_check__', 'check', 'Transport');

  select count(*) into n from category_corrections where recipient = '__migration_check__';
  if n <> 1 then
    raise exception 'category_corrections insert check failed (got % rows)', n;
  end if;

  delete from category_corrections where recipient = '__migration_check__';
  raise notice 'category_corrections verified';
end
$$;

-- Expect one row, explanation listed.
select column_name, data_type
  from information_schema.columns
 where table_name = 'transactions' and column_name = 'explanation';
