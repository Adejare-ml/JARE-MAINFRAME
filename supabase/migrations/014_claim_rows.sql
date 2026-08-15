-- ============================================================================
-- 014_claim_rows.sql
--
-- Run after 013. Idempotent; safe to re-run. **Changes no policy.**
--
-- Gives every row an owner, so that 015 can ask who owns it.
--
-- ---------------------------------------------------------------------------
-- STOP AFTER THIS FILE. Open the app and check nothing has disappeared.
-- ---------------------------------------------------------------------------
--
-- This is deliberately two migrations with a pause, and the pause is the point.
--
-- Eight tables carry `user_id uuid default auth.uid()`. That default only fires
-- for a signed-in browser session. All four scheduled scripts write with the
-- **service-role key, which has no `auth.uid()`** — so every transaction the
-- Gmail sync has ever imported, every `sync_failures` row, every `day_briefs`
-- row and every goal the generator wrote almost certainly has `user_id` NULL.
--
-- Switching straight to `auth.uid() = user_id` would therefore not "tighten
-- security". It would empty your screens while reporting success — this
-- project's signature failure, wearing a security hat. So this file only
-- backfills, and 015 only tightens, and you get to look in between.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The two tables that have no owner column at all
--
-- 004's rationale added `user_id` to `debts` specifically so multi-tenancy
-- would not need a backfill later. `category_corrections` (005) and
-- `sync_failures` (008) did not follow it, so they need the column before they
-- can be claimed — which is the work 004 was trying to avoid, arriving anyway.
-- ---------------------------------------------------------------------------

alter table category_corrections add column if not exists user_id uuid default auth.uid();
alter table sync_failures        add column if not exists user_id uuid default auth.uid();


-- ---------------------------------------------------------------------------
-- 2. Who owns this ledger
--
-- Derived rather than typed, because a uuid pasted into a migration is a uuid
-- nobody can check. Two ways in:
--
--   one account in auth.users  -> that account, no input needed
--   more than one              -> you must name it, by running
--
--       set local jare.owner = 'the-uuid-you-mean';
--
--     in the same statement batch, immediately before this file
--
-- and if neither holds, this raises. Guessing which account owns a ledger is
-- not a migration's decision to make, and picking "the oldest" or "the first"
-- would be exactly that.
-- ---------------------------------------------------------------------------

do $$
declare
  owner_id  uuid;
  user_count integer;
  claimed    integer;
  total      integer := 0;
begin
  -- An explicit setting always wins, so a multi-user project has a way through.
  begin
    owner_id := nullif(current_setting('jare.owner', true), '')::uuid;
  exception when others then
    raise exception 'jare.owner is set but is not a uuid: %', current_setting('jare.owner', true);
  end;

  if owner_id is null then
    select count(*) into user_count from auth.users;

    if user_count = 0 then
      raise exception
        'auth.users is empty, so there is nobody to give these rows to. Sign in to the app once, then re-run this file.';
    elsif user_count > 1 then
      raise exception
        'auth.users holds % accounts, so the owner is ambiguous. Re-run this file with the owner named first: set local jare.owner = ''<uuid>'';  (list them with: select id, email, created_at from auth.users order by created_at;)',
        user_count;
    end if;

    select id into owner_id from auth.users;
  end if;

  raise notice 'claiming every unowned row for %', owner_id;

  -- Only NULLs are touched. A row that already has an owner keeps it, which is
  -- what makes this safe to re-run and safe on a database that has been used by
  -- a signed-in browser.
  update transactions        set user_id = owner_id where user_id is null;
  get diagnostics claimed = row_count; total := total + claimed;
  raise notice '  transactions:         %', claimed;

  update wallets             set user_id = owner_id where user_id is null;
  get diagnostics claimed = row_count; total := total + claimed;
  raise notice '  wallets:              %', claimed;

  update user_settings       set user_id = owner_id where user_id is null;
  get diagnostics claimed = row_count; total := total + claimed;
  raise notice '  user_settings:        %', claimed;

  update integrations        set user_id = owner_id where user_id is null;
  get diagnostics claimed = row_count; total := total + claimed;
  raise notice '  integrations:         %', claimed;

  update goals               set user_id = owner_id where user_id is null;
  get diagnostics claimed = row_count; total := total + claimed;
  raise notice '  goals:                %', claimed;

  update debts               set user_id = owner_id where user_id is null;
  get diagnostics claimed = row_count; total := total + claimed;
  raise notice '  debts:                %', claimed;

  update category_corrections set user_id = owner_id where user_id is null;
  get diagnostics claimed = row_count; total := total + claimed;
  raise notice '  category_corrections: %', claimed;

  update sync_failures       set user_id = owner_id where user_id is null;
  get diagnostics claimed = row_count; total := total + claimed;
  raise notice '  sync_failures:        %', claimed;

  update knowledge_gaps      set user_id = owner_id where user_id is null;
  get diagnostics claimed = row_count; total := total + claimed;
  raise notice '  knowledge_gaps:       %', claimed;

  update day_briefs          set user_id = owner_id where user_id is null;
  get diagnostics claimed = row_count; total := total + claimed;
  raise notice '  day_briefs:           %', claimed;

  raise notice '% row(s) claimed in total', total;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. Verify
--
-- The one thing 015 depends on: nothing is left unowned. If a single row on a
-- single table still has a NULL user_id, 015 would hide it — so this raises
-- and names the table rather than letting the next file do the damage.
-- ---------------------------------------------------------------------------

do $$
declare
  unowned text;
begin
  select string_agg(format('%s (%s)', t, n), ', ')
    into unowned
    from (
      select 'transactions' as t, count(*) as n from transactions where user_id is null
      union all select 'wallets',             count(*) from wallets             where user_id is null
      union all select 'user_settings',       count(*) from user_settings       where user_id is null
      union all select 'integrations',        count(*) from integrations        where user_id is null
      union all select 'goals',               count(*) from goals               where user_id is null
      union all select 'debts',               count(*) from debts               where user_id is null
      union all select 'category_corrections', count(*) from category_corrections where user_id is null
      union all select 'sync_failures',       count(*) from sync_failures       where user_id is null
      union all select 'knowledge_gaps',      count(*) from knowledge_gaps      where user_id is null
      union all select 'day_briefs',          count(*) from day_briefs          where user_id is null
    ) counts
   where n > 0;

  if unowned is not null then
    raise exception 'rows are still unowned and 015 would hide them: %', unowned;
  end if;

  raise notice 'every row on all ten tables has an owner; 015 is safe to run';
end
$$;


-- ---------------------------------------------------------------------------
-- 4. What you are checking before you run 015
--
-- These are the counts the app should still show. Note them, open the app, and
-- confirm the ledger, the wallets and the goals all look the way they did.
-- Nothing has been hidden yet — the policy is still permissive — so if anything
-- is already missing here, the problem predates this stage.
-- ---------------------------------------------------------------------------

select 'transactions'         as table_name, count(*) as rows, count(distinct user_id) as owners from transactions
union all select 'wallets',              count(*), count(distinct user_id) from wallets
union all select 'user_settings',        count(*), count(distinct user_id) from user_settings
union all select 'integrations',         count(*), count(distinct user_id) from integrations
union all select 'goals',                count(*), count(distinct user_id) from goals
union all select 'debts',                count(*), count(distinct user_id) from debts
union all select 'category_corrections', count(*), count(distinct user_id) from category_corrections
union all select 'sync_failures',        count(*), count(distinct user_id) from sync_failures
union all select 'knowledge_gaps',       count(*), count(distinct user_id) from knowledge_gaps
union all select 'day_briefs',           count(*), count(distinct user_id) from day_briefs
order by table_name;
