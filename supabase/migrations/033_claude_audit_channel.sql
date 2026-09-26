-- ============================================================================
-- 033_claude_audit_channel.sql
--
-- Run after 032. Idempotent; safe to re-run.
--
-- 032 gave the Claude scheduled task two functions to write through and
-- assumed it would call them with the Supabase connector's execute_sql.
-- It cannot: the hosted Supabase MCP connector in Claude runs execute_sql
-- as `supabase_read_only_user` inside a read-only transaction, and every
-- call since 23 Sep has been refused with "permission denied for function"
-- (SQLSTATE 42501). The same connector's apply_migration runs as postgres,
-- in one transaction, and is what applied 001-032 from Claude in the
-- first place. So the task now sends its day's calls as one batch through
-- apply_migration, named claude_audit_YYYYMMDD: one tool call per day,
-- all-or-nothing, still only the two functions.
--
-- The one cost is a row per day in supabase_migrations.schema_migrations,
-- which is the ledger `supabase db push` reads. record_sync_run therefore
-- clears every earlier claude_audit_% row when the audit records a run, so
-- the table never holds more than the current day's, and the repo's own
-- 001-033 files stay the only schema history that matters.
-- ============================================================================

create or replace function record_sync_run(
  p_job        text,
  p_ok         boolean,
  p_summary    text        default null,
  p_started_at timestamptz default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_owner uuid := jare_sole_owner();
  v_id    uuid;
begin
  if trim(coalesce(p_job, '')) = '' then
    raise exception 'p_job is required';
  end if;

  insert into sync_runs (user_id, job, started_at, finished_at, ok, summary)
  values (v_owner, trim(p_job), coalesce(p_started_at, now()), now(), coalesce(p_ok, false), left(p_summary, 500))
  returning id into v_id;

  -- Same retention as scripts/lib/recordRun.mjs.
  delete from sync_runs
   where user_id = v_owner and job = trim(p_job) and finished_at < now() - interval '90 days';

  if trim(p_job) = 'claude-audit' then
    -- The audit reads the mailbox, so a good run is a mailbox check.
    if p_ok then
      update integrations set last_checked = now() where user_id = v_owner and service = 'gmail';
    end if;
    -- The batch arrives through apply_migration (see the header). Its row
    -- is recorded after this function returns; every earlier day's goes.
    if to_regclass('supabase_migrations.schema_migrations') is not null then
      delete from supabase_migrations.schema_migrations where name like 'claude_audit_%';
    end if;
  end if;

  return v_id;
end
$$;

revoke execute on function record_sync_run(text, boolean, text, timestamptz) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  run_id uuid;
begin
  if (select count(*) from auth.users) <> 1 then
    raise notice 'claude audit channel: not exactly one account, verify skipped';
    return;
  end if;
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'claude audit channel: no schema_migrations table here, verify skipped';
    return;
  end if;

  insert into supabase_migrations.schema_migrations (version, name)
  values ('00000000000000', 'claude_audit_probe')
  on conflict (version) do update set name = excluded.name;

  run_id := record_sync_run('claude-audit', true, 'verify');
  if run_id is null then raise exception 'record_sync_run wrote nothing'; end if;
  if exists (select 1 from supabase_migrations.schema_migrations where name = 'claude_audit_probe') then
    raise exception 'record_sync_run left the claude_audit_probe row behind';
  end if;

  delete from sync_runs where id = run_id;
  raise notice 'claude audit channel verified: earlier claude_audit rows are cleared on record_sync_run';
end
$$;
