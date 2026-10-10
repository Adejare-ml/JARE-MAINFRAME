-- ============================================================================
-- 040_reconcile_balances.sql
--
-- Run after 039. Idempotent; safe to re-run.
--
-- A nightly check that the ledger and the banks still agree. Two things go
-- wrong silently today: a manual entry moves a wallet after its last alert
-- and nothing ever confirms the bank saw the same money; and an alert the
-- audit never recorded (a mail the search missed, a run that stopped at a
-- refusal) leaves a hole that only shows up weeks later as a balance
-- nobody can explain. Both are arithmetic on rows already in the ledger,
-- so this runs inside Postgres on pg_cron like the snapshot (037) and
-- records itself as the job 'reconcile' in sync_runs, which Settings →
-- System, Daily HQ and the morning reminder already read.
--
-- Per active wallet with at least one bank alert:
--   expected = the balance stated by the latest alert
--            + every manual entry dated after that alert (credits - debits)
--   drift    = wallets.balance - expected          (more than ₦1 is a drift)
-- and, within the last 30 days, a "gap" is two consecutive alerts where
-- the earlier stated balance moved by the later alert's amount does not
-- land on the later stated balance: an alert in between was never
-- recorded. The run is ok only when there is no drift and no gap; the
-- summary names each wallet and the day of each gap so the fix is a search
-- in the mailbox, not a hunt.
--
-- Also housekeeping pg_cron's own log, which otherwise grows forever.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The check as a function
-- ---------------------------------------------------------------------------

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
  v_prev_day date;
  v_moved    numeric;
  v_gaps     integer;
  v_gap_days text[];
  v_checked  integer := 0;
  v_drifts   text[] := '{}';
  v_gap_list text[] := '{}';
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
      if not found then continue; end if;
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

      -- Gaps between consecutive alerts in the window.
      v_gaps := 0;
      v_gap_days := '{}';
      v_prev_bal := null;
      v_prev_day := null;
      for a in
        select transaction_date, type, amount, available_balance
          from transactions
         where wallet_id = w.id and voided is false and available_balance is not null
           and transaction_date >= v_since
         order by transaction_date, transaction_time nulls first, created_at
      loop
        if v_prev_bal is not null then
          v_moved := v_prev_bal + case when a.type = 'credit' then a.amount else -a.amount end;
          if abs(v_moved - a.available_balance) > 1 then
            v_gaps := v_gaps + 1;
            if not (a.transaction_date::text = any(v_gap_days)) then
              v_gap_days := array_append(v_gap_days, a.transaction_date::text);
            end if;
          end if;
        end if;
        v_prev_bal := a.available_balance;
        v_prev_day := a.transaction_date;
      end loop;
      if v_gaps > 0 then
        v_gap_list := array_append(v_gap_list,
          format('%s: %s missed alert(s) around %s', w.name, v_gaps, array_to_string(v_gap_days, ', ')));
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

    return jsonb_build_object('ok', v_ok, 'run_id', v_run, 'checked', v_checked, 'summary', v_summary, 'wallets', v_wallets);
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
-- 2. The schedule: 10:30 UTC daily, after the 10:00 snapshot
-- ---------------------------------------------------------------------------

select cron.schedule('reconcile-balances', '30 10 * * *', 'select reconcile_balances()');


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  r   jsonb;
  n   integer;
begin
  if not exists (select 1 from cron.job where jobname = 'reconcile-balances' and schedule = '30 10 * * *') then
    raise exception 'the reconcile-balances cron job is not scheduled at 10:30 UTC';
  end if;
  if (select count(*) from cron.job where jobname = 'reconcile-balances') <> 1 then
    raise exception 'more than one reconcile-balances cron job';
  end if;

  if not exists (select 1 from jare_owner) then
    raise notice 'reconcile: no pinned owner yet, function check skipped';
    return;
  end if;

  r := reconcile_balances();
  if r->>'run_id' is null then
    raise exception 'reconcile_balances recorded no run: %', r;
  end if;
  if r ? 'error' then
    raise exception 'reconcile_balances raised: %', r->>'error';
  end if;
  select count(*) into n from sync_runs where id = (r->>'run_id')::uuid and job = 'reconcile';
  if n <> 1 then raise exception 'the probe run is not in sync_runs'; end if;

  raise notice 'reconcile verified on live data: %', r->>'summary';
  -- The probe row is removed so the first real run at 10:30 is the first row.
  delete from sync_runs where id = (r->>'run_id')::uuid;
end
$$;
