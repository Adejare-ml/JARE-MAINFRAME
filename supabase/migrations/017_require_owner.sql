-- ============================================================================
-- 017_require_owner.sql
--
-- Run after 014 (which guarantees zero rows are missing an owner) and 015
-- (which makes `user_id` the security boundary). Idempotent; safe to re-run.
--
-- `user_id` has never once been declared NOT NULL, on any of the ten tables,
-- in any migration -- checked, not assumed. 014 backfilled every existing row
-- and 015 made `auth.uid() = user_id` the policy that decides what you can
-- see, but the column itself still silently accepts NULL. A future script
-- that omits `user_id` -- a new scheduled job, a copy-pasted insert, a
-- forgotten `OWNER_USER_ID` -- would insert a row RLS then hides from
-- everyone, with no error anywhere. That is this project's signature failure,
-- and right now the database itself does nothing to stop it recurring.
--
-- This closes that permanently: the column refuses the write instead of
-- accepting it and disappearing the row.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Refuse to run if any row is currently unowned
--
-- Should be impossible -- 014 backfilled everything and nothing has written
-- since without setting it explicitly -- but this file does not get to assume
-- that, only check it. If it is wrong, NOT NULL below would fail anyway; this
-- says why, by table, instead of a bare constraint-violation error.
-- ---------------------------------------------------------------------------

do $$
declare
  unowned text;
begin
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
      'refusing to add NOT NULL: these rows are still unowned -- %. Run 014_claim_rows.sql first, or find where they came from.',
      unowned;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The constraint
--
-- The `default auth.uid()` on every column stays -- it is what lets a signed-in
-- browser insert without stamping user_id by hand. NOT NULL does not conflict
-- with a default; it only refuses the write on the one path that has no
-- signed-in session and no explicit value: a script that forgot.
-- ---------------------------------------------------------------------------

alter table transactions        alter column user_id set not null;
alter table wallets              alter column user_id set not null;
alter table user_settings        alter column user_id set not null;
alter table integrations         alter column user_id set not null;
alter table goals                alter column user_id set not null;
alter table debts                alter column user_id set not null;
alter table category_corrections alter column user_id set not null;
alter table sync_failures        alter column user_id set not null;
alter table knowledge_gaps       alter column user_id set not null;
alter table day_briefs           alter column user_id set not null;


-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------

do $$
declare
  still_nullable text;
begin
  select string_agg(format('%s.%s', table_name, column_name), ', ')
    into still_nullable
    from information_schema.columns
   where table_schema = 'public'
     and column_name = 'user_id'
     and table_name in ('transactions','wallets','user_settings','integrations','goals',
                        'debts','category_corrections','sync_failures','knowledge_gaps','day_briefs')
     and is_nullable = 'YES';

  if still_nullable is not null then
    raise exception 'user_id is still nullable on: %', still_nullable;
  end if;

  raise notice 'user_id is NOT NULL on all ten tables -- a row missing it can no longer be written at all';
end
$$;
