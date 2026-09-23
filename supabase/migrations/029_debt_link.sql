-- ============================================================================
-- 029_debt_link.sql
--
-- Run after 028. Idempotent; safe to re-run.
--
-- A loan's "paid so far" has been a number typed by hand since 004, and the
-- ledger rows that actually paid it have carried no link back. This adds
-- `transactions.debt_id` so a repayment logged from the Debts page counts
-- toward that debt on its own, and stops counting the moment it is voided
-- -- the app derives the total from the rows rather than bumping
-- `debts.amount_paid` (which would need a reversal branch in every
-- correction path). The typed field stays as the baseline: what was paid
-- before the link existed.
--
-- log_manual_transaction gains a trailing `p_debt_id uuid default null`.
-- It is DROPPED and recreated rather than `create or replace`d: with a new
-- parameter, `create or replace` leaves the old nine-argument signature
-- beside the new one, and PostgREST then answers every call with PGRST203
-- ("could not choose the best candidate function") -- the app would lose
-- QuickLog entirely. The verify block counts the overloads to prove it.
-- ============================================================================

alter table transactions
  add column if not exists debt_id uuid references debts(id) on delete set null;

-- Only linked rows are ever looked up by debt, and they are a small minority
-- of the table, so a partial index is both smaller and the one the planner
-- wants for `where debt_id = $1`.
create index if not exists transactions_debt_idx on transactions (debt_id)
  where debt_id is not null;


-- ---------------------------------------------------------------------------
-- log_manual_transaction, with the link
--
-- Same body as 002 with two additions: the link is written on insert, and a
-- debt the caller cannot see is refused. That check runs as the invoker, so
-- RLS on debts decides visibility -- the FK alone would accept any uuid,
-- because constraint checks bypass row security.
-- ---------------------------------------------------------------------------

drop function if exists log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time);

create function log_manual_transaction(
  p_transaction_id text,
  p_wallet_id      uuid,
  p_type           text,
  p_amount         numeric,
  p_category       text,
  p_note           text default null,
  p_want_or_need   text default null,
  p_date           date default null,
  p_time           time default null,
  p_debt_id        uuid default null
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
  if p_debt_id is not null and not exists (select 1 from debts where id = p_debt_id) then
    raise exception 'debt % not found', p_debt_id;
  end if;

  insert into transactions
    (wallet_id, type, source, amount, currency, category,
     description, note, want_or_need, reviewed,
     transaction_date, transaction_time, transaction_id, confidence, debt_id)
  values
    (p_wallet_id, p_type, 'manual', p_amount, 'NGN', p_category,
     coalesce(nullif(trim(p_note), ''), p_category), nullif(trim(p_note), ''),
     nullif(p_want_or_need, ''), true,
     coalesce(p_date, current_date), coalesce(p_time, localtime(0)),
     'MAN-' || p_transaction_id, 'HIGH', p_debt_id)
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

grant execute on function log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time, uuid)
  to authenticated;


-- ---------------------------------------------------------------------------
-- Verify
--
-- Four things, in one transaction, borrowing the real account's id the way
-- 028 does so auth.uid() resolves: exactly one log_manual_transaction
-- exists; a linked call stores the link; log_wallet_transfer (which calls
-- the nine-argument form by position) still resolves against the new
-- signature; and deleting the debt nulls the link rather than deleting the
-- payment. A database with no account yet skips with a notice.
-- ---------------------------------------------------------------------------

do $$
declare
  test_user uuid;
  overloads integer;
  w         uuid;
  w2        uuid;
  d         uuid;
  xid       text := '00000000-0000-0000-0000-000000000029';
  linked    uuid;
  after_del uuid;
begin
  select count(*) into overloads
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'log_manual_transaction';
  if overloads <> 1 then
    raise exception 'expected exactly one log_manual_transaction, found % -- PostgREST cannot choose between overloads', overloads;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'transactions' and column_name = 'debt_id'
  ) then
    raise exception 'transactions.debt_id was not created';
  end if;

  select id into test_user from auth.users order by created_at limit 1;
  if test_user is null then
    raise notice 'debt link: no account yet, round-trip verify skipped';
    return;
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', test_user::text, 'role', 'authenticated')::text, true);

  insert into wallets (user_id, name, type, balance, source_slug)
  values (test_user, '__debt_link_check__', 'bank', 1000, 'debt_link_check')
  returning id into w;
  insert into wallets (user_id, name, type, balance, source_slug)
  values (test_user, '__debt_link_check_2__', 'savings', 0, 'debt_link_check_2')
  returning id into w2;
  insert into debts (user_id, direction, kind, counterparty, principal)
  values (test_user, 'i_owe', 'loan', '__debt_link_check__', 1000)
  returning id into d;

  perform log_manual_transaction(xid, w, 'debit', 250, 'Loan Repayment', null, null, null, null, d);
  select debt_id into linked from transactions where transaction_id = 'MAN-' || xid;
  if linked is distinct from d then
    raise exception 'linked payment did not store its debt_id (got %)', linked;
  end if;

  -- The nine-argument caller must still resolve: log_wallet_transfer passes
  -- its arguments by position and lets p_debt_id default.
  perform log_wallet_transfer(xid || '-xfer', w, w2, 100, 'Savings Transfer', 'Savings');
  if (select balance from wallets where id = w) <> 650 then
    raise exception 'log_wallet_transfer no longer resolves against the new log_manual_transaction';
  end if;

  delete from debts where id = d;
  select debt_id into after_del from transactions where transaction_id = 'MAN-' || xid;
  if after_del is not null then
    raise exception 'deleting a debt should null the link, not keep it';
  end if;
  if not exists (select 1 from transactions where transaction_id = 'MAN-' || xid) then
    raise exception 'deleting a debt deleted its payment row';
  end if;

  delete from transactions where wallet_id in (w, w2);
  delete from wallets where id in (w, w2);

  raise notice 'debt link verified: one overload, link stored, transfer still resolves, delete nulls the link';
end
$$;
