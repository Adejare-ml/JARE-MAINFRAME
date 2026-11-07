-- ============================================================================
-- 047_reconcile_carry.sql
--
-- Run after 046. Idempotent; safe to re-run. The 10:30 UTC pg_cron job from
-- 040 is untouched and picks up the new body on its next run.
--
-- Three faults in the nightly reconciliation (040), all named by the council
-- review of 18 Oct and pinned by the migration harness before this file:
--
-- 1. The alert chain skipped rows that stated no balance, so a correctly
--    recorded PalmPay debit (its mails never state one) or a manual entry
--    between two stated balances broke the chain and was reported as a
--    missed alert. Those rows are now carried: the next stated balance must
--    equal the previous one moved by everything in between.
-- 2. A wallet whose alerts never state a balance (PiggyVest) was passed over
--    in silence. It is now named in the summary as unverifiable, which is
--    a note, not a failure.
-- 3. The gap day list was unbounded while record_sync_run keeps 500
--    characters, so a bad month was cut exactly where the days were. The
--    first five days (the oldest, where the Routine's re-search should
--    start) are listed and the rest counted.
--
-- The summary keeps every token src/lib/health.js and the Routine prompt
-- read: "N wallet(s) checked", "; " between segments, " off by " for a
-- drift, "missed alert(s) around" for a gap, ", ledger and bank alerts
-- agree" when clean. The function is redefined in full from 040's body.
-- ============================================================================

create or replace function reconcile_balances(p_window_days integer default 30) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_owner    uuid;
  v_since    date;
  w          record;
  a          record;
  v_latest   record;
  v_after    numeric;
  v_expected numeric;
  v_drift    numeric;
  v_prev_bal numeric;
  v_carry    numeric := 0;
  v_moved    numeric;
  v_gaps     integer;
  v_gap_days text[];
  v_checked  integer := 0;
  v_drifts   text[] := '{}';
  v_gap_list text[] := '{}';
  v_unverified text[] := '{}';
  v_wallets  jsonb := '[]'::jsonb;
  v_ok       boolean;
  v_summary  text;
  v_run      uuid;
begin
  begin
    v_owner := jare_sole_owner();
    v_since := (now() at time zone 'Africa/Lagos')::date - greatest(coalesce(p_window_days, 30), 1);

    for w in
      select id, name, balance
        from wallets
       where user_id = v_owner and is_active is true
       order by name
    loop
      -- The latest alert that stated a balance. Ties on the same second are
      -- broken by insertion order, which is the order the audit read them.
      select transaction_date, transaction_time, available_balance, created_at
        into v_latest
        from transactions
       where wallet_id = w.id and voided is false and available_balance is not null
       order by transaction_date desc, transaction_time desc nulls last, created_at desc
       limit 1;
      if not found then
        -- Alerts, but none that stated a balance (PiggyVest never does):
        -- nothing to check against, and the summary says so instead of
        -- passing the wallet over in silence.
        if exists (select 1 from transactions
                    where wallet_id = w.id and voided is false and transaction_id like 'CLA-%') then
          v_unverified := array_append(v_unverified, w.name);
        end if;
        continue;
      end if;
      v_checked := v_checked + 1;

      -- Manual entries after that alert: rows with no stated balance dated
      -- later, or on the same day at a later time. A manual row with no time
      -- on the alert's own day is counted as later; it was typed after.
      select coalesce(sum(case when type = 'credit' then amount else -amount end), 0)
        into v_after
        from transactions
       where wallet_id = w.id and voided is false and available_balance is null
         and (transaction_date > v_latest.transaction_date
              or (transaction_date = v_latest.transaction_date
                  and coalesce(transaction_time, '23:59:59'::time) > coalesce(v_latest.transaction_time, '00:00:00'::time)));

      v_expected := v_latest.available_balance + v_after;
      v_drift := coalesce(w.balance, 0) - v_expected;
      if abs(v_drift) > 1 then
        v_drifts := array_append(v_drifts,
          format('%s off by %s (ledger %s, bank %s as of %s)', w.name, round(v_drift, 2), round(w.balance, 2), round(v_expected, 2), v_latest.transaction_date));
      end if;

      -- Gaps between consecutive stated balances in the window. Rows that
      -- state no balance (a PalmPay debit, a manual entry) are carried:
      -- the next stated balance must equal the previous one moved by every
      -- row in between, not only by itself. 040 skipped those rows and so
      -- reported a correctly recorded no-balance alert as a missed one.
      v_gaps := 0;
      v_gap_days := '{}';
      v_prev_bal := null;
      v_carry := 0;
      for a in
        select transaction_date, type, amount, available_balance
          from transactions
         where wallet_id = w.id and voided is false
           and transaction_date >= v_since
         order by transaction_date, transaction_time nulls first, created_at
      loop
        if a.available_balance is null then
          if v_prev_bal is not null then
            v_carry := v_carry + case when a.type = 'credit' then a.amount else -a.amount end;
          end if;
          continue;
        end if;
        if v_prev_bal is not null then
          v_moved := v_prev_bal + v_carry + case when a.type = 'credit' then a.amount else -a.amount end;
          if abs(v_moved - a.available_balance) > 1 then
            v_gaps := v_gaps + 1;
            if not (a.transaction_date::text = any(v_gap_days)) then
              v_gap_days := array_append(v_gap_days, a.transaction_date::text);
            end if;
          end if;
        end if;
        v_prev_bal := a.available_balance;
        v_carry := 0;
      end loop;
      if v_gaps > 0 then
        -- The first five days only (the oldest, where the Routine's search
        -- should start); the rest are counted. record_sync_run keeps 500
        -- characters and a long list was cut exactly where the days were.
        v_gap_list := array_append(v_gap_list,
          format('%s: %s missed alert(s) around %s%s', w.name, v_gaps,
                 array_to_string(v_gap_days[1:5], ', '),
                 case when cardinality(v_gap_days) > 5
                      then format(' and %s more day(s)', cardinality(v_gap_days) - 5) else '' end));
      end if;

      v_wallets := v_wallets || jsonb_build_object(
        'wallet', w.name, 'ledger', w.balance, 'expected', v_expected, 'drift', round(v_drift, 2),
        'last_alert', v_latest.transaction_date, 'gaps', v_gaps, 'gap_days', to_jsonb(v_gap_days));
    end loop;

    v_ok := cardinality(v_drifts) = 0 and cardinality(v_gap_list) = 0;
    v_summary := format('%s wallet(s) checked', v_checked);
    if cardinality(v_drifts) > 0 then
      v_summary := v_summary || '; ' || array_to_string(v_drifts, '; ');
    end if;
    if cardinality(v_gap_list) > 0 then
      v_summary := v_summary || '; ' || array_to_string(v_gap_list, '; ');
    end if;
    -- Not a disagreement, so it does not touch v_ok; read as a plain note
    -- by src/lib/health.js (neither a drift nor a gap).
    if cardinality(v_unverified) > 0 then
      v_summary := v_summary || format('; unverifiable (no stated balance): %s', array_to_string(v_unverified, ', '));
    end if;
    if v_ok then
      v_summary := v_summary || ', ledger and bank alerts agree';
    end if;

    v_run := record_sync_run('reconcile', v_ok, v_summary);

    -- pg_cron keeps one row per run forever; a month is plenty to debug.
    begin
      delete from cron.job_run_details where end_time < now() - interval '30 days';
    exception when others then
      null;
    end;

    return jsonb_build_object('ok', v_ok, 'run_id', v_run, 'checked', v_checked, 'summary', v_summary, 'wallets', v_wallets,
                              'unverified', to_jsonb(v_unverified));
  exception when others then
    begin
      v_run := record_sync_run('reconcile', false, left(sqlerrm, 500));
    exception when others then
      null;
    end;
    return jsonb_build_object('ok', false, 'run_id', v_run, 'error', sqlerrm);
  end;
end
$$;

revoke execute on function reconcile_balances(integer) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  owner_id uuid;
  w_chain  uuid;
  w_gaps   uuid;
  w_none   uuid;
  r        jsonb;
  d        integer;
begin
  if not exists (select 1 from jare_owner) then
    raise notice 'reconcile carry: no pinned owner yet, function check skipped';
    return;
  end if;
  owner_id := jare_sole_owner();

  -- 1. A no-balance row between two stated balances is carried, not a gap.
  insert into wallets (user_id, name, type, balance, source_slug)
  values (owner_id, '__carry_check__', 'mobile', 8500, 'carry_check') returning id into w_chain;
  insert into transactions (user_id, wallet_id, type, amount, currency, source, transaction_id, category,
                            description, transaction_date, transaction_time, available_balance, confidence, reviewed)
  values
    (owner_id, w_chain, 'credit', 10000, 'NGN', 'carry_check', 'CLA-047-a', 'Salary', 'x', current_date - 3, '09:00', 10000, 'HIGH', true),
    (owner_id, w_chain, 'debit',   1500, 'NGN', 'carry_check', 'CLA-047-b', 'Transport', 'x', current_date - 2, '09:00', null, 'HIGH', true),
    (owner_id, w_chain, 'debit',   2000, 'NGN', 'manual',      'MAN-047-c', 'Feeding / Groceries', 'x', current_date - 2, '12:00', null, 'HIGH', true),
    (owner_id, w_chain, 'debit',   1000, 'NGN', 'carry_check', 'CLA-047-d', 'Transport', 'x', current_date - 1, '09:00', 5500, 'HIGH', true);
  update wallets set balance = 5500, balance_as_of = (current_date - 1)::text || 'T09:00:00' where id = w_chain;

  -- 2. Seven gap days on one wallet: five listed, two counted, under 500 chars.
  insert into wallets (user_id, name, type, balance, source_slug)
  values (owner_id, '__gaps_check__', 'bank', 7000, 'gaps_check') returning id into w_gaps;
  for d in 0 .. 7 loop
    insert into transactions (user_id, wallet_id, type, amount, currency, source, transaction_id, category,
                              description, transaction_date, transaction_time, available_balance, confidence, reviewed)
    values (owner_id, w_gaps, 'debit', 100, 'NGN', 'gaps_check', 'CLA-047-g' || d, 'Transport', 'x',
            current_date - 8 + d, '09:00', 7000 - d * 500, 'HIGH', true);
  end loop;
  update wallets set balance = 7000 - 7 * 500, balance_as_of = (current_date - 1)::text || 'T09:00:00' where id = w_gaps;

  -- 3. A wallet whose alerts never state a balance.
  insert into wallets (user_id, name, type, balance, source_slug)
  values (owner_id, '__nobalance_check__', 'savings', 500, 'nobalance_check') returning id into w_none;
  insert into transactions (user_id, wallet_id, type, amount, currency, source, transaction_id, category,
                            description, transaction_date, transaction_time, available_balance, confidence, reviewed)
  values (owner_id, w_none, 'credit', 500, 'NGN', 'nobalance_check', 'CLA-047-n', 'Savings Transfer', 'x', current_date - 1, '09:00', null, 'HIGH', true);

  r := reconcile_balances();
  if r ? 'error' then raise exception 'reconcile_balances raised: %', r->>'error'; end if;
  if position('__carry_check__' in r->>'summary') > 0 then
    raise exception 'the carried chain was reported as a gap or drift: %', r->>'summary';
  end if;
  if position('__gaps_check__: 7 missed alert(s) around' in r->>'summary') = 0 then
    raise exception 'seven gaps were not reported: %', r->>'summary';
  end if;
  if position(' and 2 more day(s)' in r->>'summary') = 0 then
    raise exception 'the gap day list was not capped at five: %', r->>'summary';
  end if;
  if position('unverifiable (no stated balance): __nobalance_check__' in r->>'summary') = 0 then
    raise exception 'the wallet with no stated balance was not named: %', r->>'summary';
  end if;
  if not (r->'unverified' ? '__nobalance_check__') then raise exception 'unverified missing from the result'; end if;
  if length(r->>'summary') > 500 then raise exception 'summary is % characters', length(r->>'summary'); end if;

  delete from transactions where wallet_id in (w_chain, w_gaps, w_none);
  delete from wallets where id in (w_chain, w_gaps, w_none);
  -- The probe run is removed so the next real 10:30 run is the newest row.
  delete from sync_runs where id = (r->>'run_id')::uuid;
  raise notice 'reconcile verified: no-balance rows carried, gap days capped at five, unverifiable wallets named';
end
$$;
