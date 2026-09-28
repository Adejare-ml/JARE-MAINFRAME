-- ============================================================================
-- 037_snapshot_in_db.sql
--
-- Run after 036. Idempotent; safe to re-run.
--
-- The daily net-worth snapshot moves into the database. It was the one
-- scheduled job that could not tolerate GitHub's scheduling delay: a public
-- repository's cron runs started five hours late on 27 Sep 2026 and nine
-- hours late on the 28th, and the row is dated "yesterday" from the moment
-- the script runs, so a delay past midnight would silently skip a day. It
-- is also the one job that needs nothing outside Postgres -- one read of
-- wallets, one upsert -- so pg_cron runs it here at 10:00 UTC exactly,
-- after the 08:08 UTC bank-alert audit has moved the balances.
--
-- The same job name is recorded in sync_runs, so Settings → System, Daily
-- HQ and the morning reminder see it as before. The Actions workflow
-- (snapshot-net-worth.yml) keeps its manual trigger as a fallback and
-- loses its schedule.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. pg_cron (Supabase ships it; it only needs switching on)
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;


-- ---------------------------------------------------------------------------
-- 2. The snapshot as a function
-- ---------------------------------------------------------------------------

-- Same shape as scripts/snapshot-net-worth.mjs: every active wallet's
-- balance, the sum, one row per day upserted on (user_id, snapshot_date),
-- dated yesterday (Lagos) unless told otherwise. A failure is written to
-- sync_runs and returned rather than raised: raising would roll the
-- sync_runs row back with everything else, and the app reads that row.
create or replace function snapshot_net_worth(p_date date default null) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_owner uuid;
  v_date  date := coalesce(p_date, (now() at time zone 'Africa/Lagos')::date - 1);
  v_total numeric := 0;
  v_by    jsonb := '{}'::jsonb;
  v_count integer := 0;
begin
  begin
    v_owner := jare_sole_owner();

    -- A day with no active wallets still writes a ₦0 row: a flat day is
    -- data, a missing day is a gap the chart cannot tell from "did not run".
    select coalesce(sum(balance), 0),
           coalesce(jsonb_object_agg(id, balance), '{}'::jsonb),
           count(*)
      into v_total, v_by, v_count
      from wallets
     where user_id = v_owner and is_active is true;

    insert into wallet_snapshots (user_id, snapshot_date, total_balance, by_wallet)
    values (v_owner, v_date, v_total, v_by)
    on conflict (user_id, snapshot_date)
    do update set total_balance = excluded.total_balance, by_wallet = excluded.by_wallet;

    perform record_sync_run('snapshot-net-worth', true,
      format('%s wallet(s), total %s, dated %s (pg_cron)', v_count, v_total, v_date));

    return jsonb_build_object('ok', true, 'date', v_date, 'wallets', v_count, 'total', v_total);
  exception when others then
    begin
      perform record_sync_run('snapshot-net-worth', false, left(sqlerrm, 500));
    exception when others then
      null;
    end;
    return jsonb_build_object('ok', false, 'date', v_date, 'error', sqlerrm);
  end;
end
$$;

revoke execute on function snapshot_net_worth(date) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The schedule: 10:00 UTC daily, replacing any earlier job of this name
-- ---------------------------------------------------------------------------

select cron.schedule('snapshot-net-worth', '0 10 * * *', 'select snapshot_net_worth()');


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  r     jsonb;
  probe date := '2000-01-01';
  n     integer;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not installed';
  end if;
  if not exists (select 1 from cron.job where jobname = 'snapshot-net-worth' and schedule = '0 10 * * *') then
    raise exception 'the snapshot-net-worth cron job is not scheduled at 10:00 UTC';
  end if;
  if (select count(*) from cron.job where jobname = 'snapshot-net-worth') <> 1 then
    raise exception 'more than one snapshot-net-worth cron job';
  end if;

  if not exists (select 1 from jare_owner) then
    raise notice 'snapshot in db: no pinned owner yet, function check skipped';
    return;
  end if;

  -- Twice on a probe date: one row, the second call updating the first.
  r := snapshot_net_worth(probe);
  if not (r->>'ok')::boolean then raise exception 'snapshot_net_worth failed: %', r; end if;
  r := snapshot_net_worth(probe);
  if not (r->>'ok')::boolean then raise exception 'second snapshot_net_worth failed: %', r; end if;
  select count(*) into n from wallet_snapshots where snapshot_date = probe;
  if n <> 1 then raise exception 'expected one probe snapshot, found %', n; end if;
  if (select total_balance from wallet_snapshots where snapshot_date = probe)
     <> (select coalesce(sum(balance), 0) from wallets where user_id = jare_sole_owner() and is_active is true) then
    raise exception 'the probe snapshot total does not match the wallets';
  end if;
  if not exists (select 1 from sync_runs where job = 'snapshot-net-worth' and ok and summary like '%dated ' || probe || '%') then
    raise exception 'the run was not recorded in sync_runs';
  end if;

  delete from wallet_snapshots where snapshot_date = probe;
  delete from sync_runs where job = 'snapshot-net-worth' and summary like '%dated ' || probe || '%';

  raise notice 'snapshot in db verified: pg_cron on, snapshot_net_worth() upserts and records, scheduled 10:00 UTC';
end
$$;
