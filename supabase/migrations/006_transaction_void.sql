-- ============================================================================
-- 006_transaction_void.sql
--
-- Run after 005. Idempotent; safe to re-run.
--
-- A way to take a transaction out of the books without deleting it.
--
-- Deleting is not an option here. The unique index on (source, transaction_id)
-- is what stops the sync re-inserting an email it has already seen -- so a
-- hard-deleted synced row becomes eligible for re-insert on the very next run.
-- A delete that silently undoes itself is worse than no delete at all.
-- ============================================================================

alter table transactions
  add column if not exists voided boolean not null default false;

-- Every list and every total filters on this, so it earns an index. Partial,
-- because the app only ever asks for the rows that are NOT voided.
create index if not exists transactions_active_idx
    on transactions (transaction_date desc)
 where voided = false;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

select column_name, data_type, column_default
  from information_schema.columns
 where table_name = 'transactions' and column_name = 'voided';

-- Expect 0 on a fresh migration: nothing is voided until you void it.
select count(*) as voided_transactions from transactions where voided = true;
