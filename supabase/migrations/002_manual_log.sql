-- ============================================================================
-- 002_manual_log.sql
--
-- Run after 001. Idempotent; safe to re-run.
--
-- Fixes the worst manual-logging bug: QuickLog inserted the transaction, then
-- updated the wallet balance in a second statement that failed (it wrote a
-- column named last_updated, which does not exist -- everything else uses
-- updated_at). The user saw "Failed to log transaction" over a row that had
-- already committed, tapped again, and duplicated it, because manual rows
-- carried no transaction_id for the unique index to refuse.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. One atomic, idempotent entry point for manual transactions
--
-- The client generates a UUID when the log sheet opens and sends it as the
-- transaction_id. A retry after dropped mobile data hits the unique index on
-- (source, transaction_id), inserts nothing, and applies no second balance
-- delta -- the whole operation is a no-op.
--
-- SECURITY INVOKER on purpose: RLS is currently `to authenticated using(true)`,
-- so DEFINER would buy nothing today and become a cross-user hole the moment
-- policies are tightened.
--
-- The balance is adjusted server-side (balance = balance + delta) rather than
-- written from the client's copy, so two devices logging at once cannot
-- overwrite each other with stale reads. balance_as_of is deliberately NOT
-- touched: it records which bank *alert* a balance came from, and manual
-- deltas are not alerts.
-- ---------------------------------------------------------------------------

create or replace function log_manual_transaction(
  p_transaction_id text,
  p_wallet_id      uuid,
  p_type           text,
  p_amount         numeric,
  p_category       text,
  p_note           text default null,
  p_want_or_need   text default null,
  p_date           date default null,
  p_time           time default null
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_rows int;
begin
  if p_type not in ('debit', 'credit') then
    raise exception 'type must be debit or credit, got %', p_type;
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive, got %', p_amount;
  end if;
  if p_transaction_id is null or length(trim(p_transaction_id)) = 0 then
    raise exception 'transaction_id is required for idempotency';
  end if;

  insert into transactions
    (wallet_id, type, source, amount, currency, category,
     description, note, want_or_need, reviewed,
     transaction_date, transaction_time, transaction_id, confidence)
  values
    (p_wallet_id, p_type, 'manual', p_amount, 'NGN', p_category,
     coalesce(nullif(trim(p_note), ''), p_category), nullif(trim(p_note), ''),
     nullif(p_want_or_need, ''), true,
     coalesce(p_date, current_date), coalesce(p_time, localtime(0)),
     'MAN-' || p_transaction_id, 'HIGH')
  on conflict (source, transaction_id) do nothing;

  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    update wallets
       set balance    = coalesce(balance, 0)
                        + case when p_type = 'credit' then p_amount else -p_amount end,
           updated_at = now()
     where id = p_wallet_id;

    if not found then
      raise exception 'wallet % not found', p_wallet_id;
    end if;
  end if;

  return jsonb_build_object('inserted', v_rows > 0);
end
$$;

grant execute on function log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 2. Sync heartbeat, separate from the Gmail watermark
--
-- last_sync is a *watermark*: the newest email processed, deliberately pulled
-- backwards to retry failures. Settings was rendering it as "Last sync", which
-- reads "3 days ago" right after a perfectly healthy run whose newest bank
-- email was three days old. last_checked is the plain heartbeat: when a sync
-- last ran, regardless of what it found.
-- ---------------------------------------------------------------------------

alter table integrations add column if not exists last_checked timestamptz;


-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------

-- Same UUID twice: first call inserts, second is a no-op and the balance moves
-- exactly once. (Uses a throwaway wallet so this block is safe anywhere.)
do $$
declare
  w uuid;
  b1 numeric; b2 numeric;
begin
  insert into wallets (name, type, balance, source_slug)
  values ('__migration_check__', 'cash', 1000, 'migration_check_tmp')
  returning id into w;

  perform log_manual_transaction('00000000-0000-0000-0000-0000000000ff', w, 'debit', 250, 'Miscellaneous');
  select balance into b1 from wallets where id = w;
  perform log_manual_transaction('00000000-0000-0000-0000-0000000000ff', w, 'debit', 250, 'Miscellaneous');
  select balance into b2 from wallets where id = w;

  if b1 <> 750 or b2 <> 750 then
    raise exception 'idempotency check failed: balance after first call %, after retry %', b1, b2;
  end if;

  delete from transactions where wallet_id = w;
  delete from wallets where id = w;
  raise notice 'log_manual_transaction verified: insert once, retry no-op';
end
$$;
