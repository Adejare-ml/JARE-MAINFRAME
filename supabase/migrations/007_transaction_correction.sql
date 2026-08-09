-- ============================================================================
-- 007_transaction_correction.sql
--
-- Run after 006. Idempotent; safe to re-run.
--
-- One atomic entry point for correcting a transaction, including voiding it.
--
-- Why this needs to be an RPC rather than a plain update from the browser:
-- a manual row moved its wallet balance when it was logged (002's
-- log_manual_transaction does `balance = balance + delta`). So correcting a
-- ₦5,000 cash spend to ₦500 -- or voiding it outright -- has to move the
-- balance back by the difference, and that has to land in the same transaction
-- as the edit. Two statements from a client mean a dropped connection between
-- them leaves the ledger and the balance disagreeing, with nothing to say
-- which one is lying.
--
-- Synced rows are deliberately left alone. Their wallet balance is whatever
-- the bank's most recent alert said (see balance_as_of); fixing our reading of
-- an email does not change what the bank is holding, and adjusting here would
-- drift the wallet away from the one authoritative figure it has.
-- ============================================================================

create or replace function correct_transaction(
  p_id           uuid,
  p_type         text,
  p_amount       numeric,
  p_date         date,
  p_category     text,
  p_note         text     default null,
  p_want_or_need text     default null,
  p_voided       boolean  default false
) returns jsonb
language plpgsql
security invoker
as $$
declare
  t       transactions%rowtype;
  v_old   numeric;
  v_new   numeric;
  v_delta numeric;
  v_manual boolean;
begin
  if p_type not in ('debit', 'credit') then
    raise exception 'type must be debit or credit, got %', p_type;
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive, got %', p_amount;
  end if;
  if p_date is null then
    raise exception 'transaction date is required';
  end if;

  -- FOR UPDATE so two devices correcting the same row apply their deltas in
  -- series. Without it both read the pre-edit amount and the second write
  -- silently reverses the first one's balance adjustment.
  select * into t from transactions where id = p_id for update;
  if not found then
    raise exception 'transaction % not found', p_id;
  end if;

  -- A voided row contributes nothing, which is what makes this arithmetic
  -- cover void, un-void, an amount change and a direction flip with one
  -- expression -- and makes voiding twice a no-op rather than a double refund.
  v_old := case when t.voided then 0
                when t.type = 'credit' then coalesce(t.amount, 0)
                else -coalesce(t.amount, 0) end;
  v_new := case when p_voided then 0
                when p_type = 'credit' then p_amount
                else -p_amount end;
  v_delta := v_new - v_old;

  v_manual := t.source = 'manual' and t.wallet_id is not null;

  update transactions
     set type             = p_type,
         amount           = p_amount,
         transaction_date = p_date,
         category         = p_category,
         note             = nullif(trim(p_note), ''),
         want_or_need     = nullif(p_want_or_need, ''),
         voided           = p_voided,
         -- Correcting a row is reviewing it. Note `description` is not touched:
         -- it holds the bank's own narration and is the text a category
         -- correction keys on.
         reviewed         = true
   where id = p_id;

  if v_manual and v_delta <> 0 then
    update wallets
       set balance    = coalesce(balance, 0) + v_delta,
           updated_at = now()
     where id = t.wallet_id;

    if not found then
      raise exception 'wallet % not found', t.wallet_id;
    end if;
  end if;

  return jsonb_build_object(
    'balance_delta', case when v_manual then v_delta else 0 end,
    'wallet_adjusted', v_manual and v_delta <> 0
  );
end
$$;

grant execute on function correct_transaction(uuid, text, numeric, date, text, text, text, boolean)
  to authenticated;


-- ---------------------------------------------------------------------------
-- Verify
--
-- Walks a manual row through every correction that moves a balance, and
-- asserts a synced row moves none.
-- ---------------------------------------------------------------------------

do $$
declare
  w   uuid;
  txn uuid;
  b   numeric;
begin
  insert into wallets (name, type, balance, source_slug)
  values ('__migration_check_007__', 'cash', 1000, 'migration_check_007_tmp')
  returning id into w;

  -- ₦1000 wallet, ₦250 spent -> ₦750
  perform log_manual_transaction('00000000-0000-0000-0000-0000000007ff', w, 'debit', 250, 'Miscellaneous');
  select id into txn from transactions where wallet_id = w limit 1;

  -- Corrected to ₦100 -> ₦900
  perform correct_transaction(txn, 'debit', 100, current_date, 'Miscellaneous');
  select balance into b from wallets where id = w;
  if b <> 900 then raise exception 'amount correction: expected 900, got %', b; end if;

  -- Voided -> back to ₦1000
  perform correct_transaction(txn, 'debit', 100, current_date, 'Miscellaneous', null, null, true);
  select balance into b from wallets where id = w;
  if b <> 1000 then raise exception 'void: expected 1000, got %', b; end if;

  -- Voided again -> still ₦1000, not ₦1100
  perform correct_transaction(txn, 'debit', 100, current_date, 'Miscellaneous', null, null, true);
  select balance into b from wallets where id = w;
  if b <> 1000 then raise exception 'double void: expected 1000, got %', b; end if;

  -- Un-voided as a credit -> ₦1100
  perform correct_transaction(txn, 'credit', 100, current_date, 'Miscellaneous');
  select balance into b from wallets where id = w;
  if b <> 1100 then raise exception 'un-void as credit: expected 1100, got %', b; end if;

  -- A synced row must not touch the balance at all.
  insert into transactions
    (wallet_id, type, source, amount, currency, category, description,
     transaction_date, transaction_id, confidence, reviewed)
  values
    (w, 'debit', 'gtbank', 500, 'NGN', 'Miscellaneous', 'check',
     current_date, '__migration_check_007__', 'HIGH', true)
  returning id into txn;

  perform correct_transaction(txn, 'credit', 900, current_date, 'Miscellaneous', null, null, false);
  select balance into b from wallets where id = w;
  if b <> 1100 then raise exception 'synced row moved the balance: expected 1100, got %', b; end if;

  delete from transactions where wallet_id = w;
  delete from wallets where id = w;
  raise notice 'correct_transaction verified: edit, void, re-void and flip all settle the balance';
end
$$;
