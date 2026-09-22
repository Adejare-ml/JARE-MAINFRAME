-- ============================================================================
-- 028_wallet_transfer.sql
--
-- Run after 027. Idempotent; safe to re-run.
--
-- Moving money between two of your own wallets is two rows -- a debit on
-- one, a credit on the other -- and until now the app had no way to write
-- them except as two separate manual logs, which is two chances to get the
-- category wrong and one chance to log only half. This function writes
-- both legs inside one plpgsql body, so they commit together or not at all,
-- by calling log_manual_transaction twice: every guarantee that function
-- already has (positive amount, balance moved exactly once, idempotent on
-- the id) holds for each leg. The legs are `<id>:out` and `<id>:in`, so a
-- retry after a dropped connection is a no-op on both.
--
-- The category pair is the caller's to choose (src/lib/transfers.js), and
-- both must be transfer categories, or summarizeMonth would count one leg
-- as spending and the other as income.
-- ============================================================================

create or replace function log_wallet_transfer(
  p_transfer_id     text,
  p_from_wallet     uuid,
  p_to_wallet       uuid,
  p_amount          numeric,
  p_debit_category  text,
  p_credit_category text,
  p_note            text default null,
  p_date            date default null,
  p_time            time default null
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_out jsonb;
  v_in  jsonb;
begin
  if p_from_wallet is null or p_to_wallet is null then
    raise exception 'a transfer needs both wallets';
  end if;
  if p_from_wallet = p_to_wallet then
    raise exception 'a transfer needs two different wallets';
  end if;
  if p_transfer_id is null or length(trim(p_transfer_id)) = 0 then
    raise exception 'transfer_id is required for idempotency';
  end if;

  v_out := log_manual_transaction(
    p_transfer_id || ':out', p_from_wallet, 'debit', p_amount, p_debit_category,
    p_note, null, p_date, p_time);
  v_in := log_manual_transaction(
    p_transfer_id || ':in', p_to_wallet, 'credit', p_amount, p_credit_category,
    p_note, null, p_date, p_time);

  return jsonb_build_object('out', v_out, 'in', v_in);
end
$$;

grant execute on function log_wallet_transfer(text, uuid, uuid, numeric, text, text, text, date, time)
  to authenticated;


-- ---------------------------------------------------------------------------
-- Verify
--
-- Since 017 every row needs an owner, and log_manual_transaction takes it
-- from auth.uid() -- which is null in the SQL editor. The check borrows the
-- one real account's id for this transaction only, the way a signed-in
-- browser would carry it, so the function is exercised exactly as the app
-- calls it. A database with no account yet skips the check with a notice.
-- ---------------------------------------------------------------------------

do $$
declare
  test_user uuid;
  w_from    uuid;
  w_to      uuid;
  xid       text := '00000000-0000-0000-0000-000000000028';
  b_from    numeric;
  b_to      numeric;
  legs      integer;
  same_ok   boolean := false;
begin
  select id into test_user from auth.users order by created_at limit 1;
  if test_user is null then
    raise notice 'log_wallet_transfer: no account yet, verify skipped';
    return;
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', test_user::text, 'role', 'authenticated')::text, true);

  insert into wallets (user_id, name, type, balance, source_slug)
  values (test_user, '__xfer_from__', 'bank', 1000, 'xfer_check_from')
  returning id into w_from;
  insert into wallets (user_id, name, type, balance, source_slug)
  values (test_user, '__xfer_to__', 'savings', 1000, 'xfer_check_to')
  returning id into w_to;

  perform log_wallet_transfer(xid, w_from, w_to, 250, 'Savings Transfer', 'Savings');
  perform log_wallet_transfer(xid, w_from, w_to, 250, 'Savings Transfer', 'Savings');

  select balance into b_from from wallets where id = w_from;
  select balance into b_to   from wallets where id = w_to;
  select count(*) into legs from transactions
   where transaction_id in ('MAN-' || xid || ':out', 'MAN-' || xid || ':in');

  if b_from <> 750 or b_to <> 1250 then
    raise exception 'transfer moved the wrong amount: from % (want 750), to % (want 1250)', b_from, b_to;
  end if;
  if legs <> 2 then
    raise exception 'expected exactly two legs after a retried transfer, found %', legs;
  end if;

  begin
    perform log_wallet_transfer(xid || '-same', w_from, w_from, 10, 'Transfer Out', 'Transfer In');
    same_ok := true;
  exception when others then
    same_ok := false;
  end;
  if same_ok then
    raise exception 'log_wallet_transfer accepted a transfer to the same wallet';
  end if;

  delete from transactions where wallet_id in (w_from, w_to);
  delete from wallets where id in (w_from, w_to);

  raise notice 'log_wallet_transfer verified: two legs, balances moved once, retry a no-op';
end
$$;
