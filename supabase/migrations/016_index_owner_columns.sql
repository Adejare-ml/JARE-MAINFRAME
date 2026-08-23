-- ============================================================================
-- 016_index_owner_columns.sql
--
-- 015 made `auth.uid() = user_id` the filter on every single read and write
-- against these ten tables. Not one of them has an index on `user_id` --
-- checked against every prior migration, not assumed. Every query the app
-- makes now carries an implicit predicate Postgres has no index to satisfy,
-- so RLS is currently enforced by scanning and discarding rows that belong to
-- nobody else, on a single-user database where that has cost nothing yet
-- only because every table is still small.
--
-- Idempotent; safe to re-run.
-- ============================================================================

create index if not exists transactions_user_id_idx        on transactions        (user_id);
create index if not exists wallets_user_id_idx              on wallets              (user_id);
create index if not exists user_settings_user_id_idx        on user_settings        (user_id);
create index if not exists integrations_user_id_idx         on integrations         (user_id);
create index if not exists goals_user_id_idx                on goals                (user_id);
create index if not exists debts_user_id_idx                on debts                (user_id);
create index if not exists category_corrections_user_id_idx on category_corrections (user_id);
create index if not exists sync_failures_user_id_idx        on sync_failures        (user_id);
create index if not exists knowledge_gaps_user_id_idx       on knowledge_gaps       (user_id);
create index if not exists day_briefs_user_id_idx           on day_briefs           (user_id);

-- The one foreign key on the app's hottest table that never got an index.
-- Every wallet-scoped read (balance recompute, CashReconciliation, the wallet
-- snapshot) joins or filters on this column.
create index if not exists transactions_wallet_id_idx on transactions (wallet_id);

-- The single most common real query shape: this user's non-voided
-- transactions, newest first. 006 already indexes (transaction_date desc)
-- where voided = false without user_id; RLS adds user_id to every one of
-- those queries now, so the existing index alone no longer describes what
-- Postgres actually has to satisfy. This one does, and coexists with 006's --
-- the planner picks whichever serves a given query better, and this is not a
-- replacement for that index, just the case it does not cover.
create index if not exists transactions_user_active_date_idx
  on transactions (user_id, transaction_date desc)
  where voided = false;


-- ---------------------------------------------------------------------------
-- Verify
--
-- Asserting every index actually exists, in the style 015 established --
-- `create index if not exists` naming a table that does not exist would
-- simply never run rather than error, and a database missing 013 or 014
-- would otherwise pass this file silently having indexed nothing.
-- ---------------------------------------------------------------------------

do $$
declare
  missing text;
begin
  select string_agg(expected, ', ')
    into missing
    from unnest(array[
      'transactions_user_id_idx', 'wallets_user_id_idx', 'user_settings_user_id_idx',
      'integrations_user_id_idx', 'goals_user_id_idx', 'debts_user_id_idx',
      'category_corrections_user_id_idx', 'sync_failures_user_id_idx',
      'knowledge_gaps_user_id_idx', 'day_briefs_user_id_idx',
      'transactions_wallet_id_idx', 'transactions_user_active_date_idx'
    ]) as expected
   where not exists (
     select 1 from pg_indexes where schemaname = 'public' and indexname = expected
   );

  if missing is not null then
    raise exception 'these indexes did not get created: %', missing;
  end if;

  raise notice 'all twelve indexes present';
end
$$;
