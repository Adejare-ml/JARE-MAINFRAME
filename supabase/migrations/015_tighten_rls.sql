-- ============================================================================
-- 015_tighten_rls.sql
--
-- Run after 014, and only after you have opened the app and confirmed nothing
-- disappeared. Idempotent; safe to re-run.
--
-- Ends the arrangement where every authenticated user could read, write and
-- delete every row of every table.
--
-- Ten tables, one policy each, all identical:
--
--     for all to authenticated using (true) with check (true)
--
-- `using (true)` means the policy filters nothing. `for all` means it covers
-- SELECT, INSERT, UPDATE and DELETE in one statement — so a signed-in stranger
-- could not only read the whole ledger, they could delete it. Four of the ten
-- tables already carried `user_id`, populated on every browser write and read by
-- no policy: the column has been sitting there, correct and inert, since 004.
--
-- The comments in 004, 009, 011 and 012 all say the same thing — "tighten to
-- (auth.uid() = user_id) when multi-tenancy lands". Multi-tenancy has not
-- landed. What has landed is the realisation that this is not a multi-tenancy
-- feature, it is the difference between a private ledger and a public one, and
-- it does not need a second user to matter.
--
-- ---------------------------------------------------------------------------
-- Why this is safe to run now, and would not have been an hour ago
-- ---------------------------------------------------------------------------
--
-- 014 gave every row an owner. Without it, this file would have been a disaster
-- dressed as a fix: the scheduled scripts write with the service-role key, which
-- has no `auth.uid()`, so nearly every synced row had `user_id` NULL, and
-- `auth.uid() = NULL` is NULL — never true. Every one of those rows would have
-- vanished from the app while this file reported success.
--
-- The service role bypasses RLS entirely, so the four scripts keep working
-- either way. That is also why they must now set `user_id` explicitly: a row
-- they write without it is a row you cannot see.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Refuse to run if 014 was skipped
--
-- First, before any policy changes, because the failure this prevents is
-- silent: a NULL user_id under the new policy is a row nobody can read, and
-- there is no error anywhere — the app simply shows less than it did.
-- ---------------------------------------------------------------------------

do $$
declare
  unowned  text;
  no_column text;
begin
  -- First: does every table even have the column? `category_corrections` and
  -- `sync_failures` only get it in 014, so without that file the query below
  -- fails with a bare `column "user_id" does not exist` — which is a refusal,
  -- but one that names neither the cause nor the fix.
  select string_agg(t, ', ')
    into no_column
    from unnest(array['transactions','wallets','user_settings','integrations','goals',
                      'debts','category_corrections','sync_failures','knowledge_gaps',
                      'day_briefs']) as t
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'user_id'
   );

  if no_column is not null then
    raise exception
      'these tables have no user_id column, so there is nothing to match on — %. Run 014_claim_rows.sql first.',
      no_column;
  end if;

  select string_agg(format('%s (%s row(s))', t, n), ', ')
    into unowned
    from (
      select 'transactions' as t, count(*) as n from transactions where user_id is null
      union all select 'wallets',              count(*) from wallets              where user_id is null
      union all select 'user_settings',        count(*) from user_settings        where user_id is null
      union all select 'integrations',         count(*) from integrations         where user_id is null
      union all select 'goals',                count(*) from goals                where user_id is null
      union all select 'debts',                count(*) from debts                where user_id is null
      union all select 'category_corrections', count(*) from category_corrections where user_id is null
      union all select 'sync_failures',        count(*) from sync_failures        where user_id is null
      union all select 'knowledge_gaps',       count(*) from knowledge_gaps       where user_id is null
      union all select 'day_briefs',           count(*) from day_briefs           where user_id is null
    ) counts
   where n > 0;

  if unowned is not null then
    raise exception
      'refusing to tighten: these rows have no owner and would become invisible to everyone — %. Run 014_claim_rows.sql first.',
      unowned;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The policies
--
-- `using` governs which existing rows you can see and act on; `with check`
-- governs what you are allowed to write. Both are needed: `using` alone would
-- let you insert a row owned by somebody else, which you would then be unable
-- to read — a way to lose data into a table you can no longer reach.
--
-- Policy names are unchanged, so `drop policy if exists` finds the old one and
-- this file replaces it in place.
-- ---------------------------------------------------------------------------

drop policy if exists transactions_all_authenticated on transactions;
create policy transactions_all_authenticated on transactions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists wallets_all_authenticated on wallets;
create policy wallets_all_authenticated on wallets
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists user_settings_all_authenticated on user_settings;
create policy user_settings_all_authenticated on user_settings
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The one holding a live Google access token.
drop policy if exists integrations_all_authenticated on integrations;
create policy integrations_all_authenticated on integrations
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists goals_all_authenticated on goals;
create policy goals_all_authenticated on goals
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists debts_all_authenticated on debts;
create policy debts_all_authenticated on debts
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 005 named this one differently from every other table.
drop policy if exists "authenticated access" on category_corrections;
drop policy if exists category_corrections_all_authenticated on category_corrections;
create policy category_corrections_all_authenticated on category_corrections
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists sync_failures_all_authenticated on sync_failures;
create policy sync_failures_all_authenticated on sync_failures
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists knowledge_gaps_all_authenticated on knowledge_gaps;
create policy knowledge_gaps_all_authenticated on knowledge_gaps
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists day_briefs_all_authenticated on day_briefs;
create policy day_briefs_all_authenticated on day_briefs
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 3. Verify
--
-- Asserting the policies actually changed, rather than assuming the statements
-- above did what they read like. A `drop policy if exists` naming a policy that
-- was never there succeeds silently, so a typo in a policy name would leave the
-- permissive one in place and this file would still report success — which is
-- the exact failure shape this project keeps finding.
-- ---------------------------------------------------------------------------

do $$
declare
  still_open text;
  checked    integer;
begin
  -- Every policy on every one of the ten tables must now mention user_id. Any
  -- that still reads `true` is one this file failed to replace.
  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into still_open
    from pg_policies
   where schemaname = 'public'
     and tablename in ('transactions','wallets','user_settings','integrations','goals',
                       'debts','category_corrections','sync_failures','knowledge_gaps','day_briefs')
     and (coalesce(qual, '') not like '%user_id%'
          or coalesce(with_check, '') not like '%user_id%');

  if still_open is not null then
    raise exception 'these policies are still permissive: %', still_open;
  end if;

  -- And there must be one on each, or a table with RLS enabled and no policy
  -- is a table nobody can read at all.
  select count(distinct tablename) into checked
    from pg_policies
   where schemaname = 'public'
     and tablename in ('transactions','wallets','user_settings','integrations','goals',
                       'debts','category_corrections','sync_failures','knowledge_gaps','day_briefs');

  if checked <> 10 then
    raise exception 'only % of the 10 tables have a policy; the rest are unreadable', checked;
  end if;

  raise notice 'all ten policies now match on auth.uid() = user_id, for both using and with check';
end
$$;

-- Every policy, so you can read back what is now in force.
select tablename, policyname, qual as using_clause, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('transactions','wallets','user_settings','integrations','goals',
                     'debts','category_corrections','sync_failures','knowledge_gaps','day_briefs')
 order by tablename;
