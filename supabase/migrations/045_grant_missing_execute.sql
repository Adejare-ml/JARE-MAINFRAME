-- ============================================================================
-- 045_grant_missing_execute.sql
--
-- Multiple RPC functions had execution revoked from public/anon in previous
-- migrations (032-043) but did not explicitly re-grant execution to the
-- `authenticated` role. Because `authenticated` inherits from `public` in
-- PostgreSQL, revoking from `public` without a specific grant to `authenticated`
-- blocks frontend users from calling these functions.
-- ============================================================================

grant execute on function jare_sole_owner() to authenticated;
grant execute on function record_sync_run(text, boolean, text, timestamptz) to authenticated;
grant execute on function jare_builtin_categories() to authenticated;
grant execute on function jare_names_own_account(text) to authenticated;
grant execute on function snapshot_net_worth(date) to authenticated;
grant execute on function reconcile_balances(integer) to authenticated;
grant execute on function note_discovered_account(text, text, text, numeric, date, text, text) to authenticated;

do $$
declare
  f record;
  missing boolean := false;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('jare_sole_owner', 'record_sync_run', 'jare_builtin_categories', 'jare_names_own_account', 'snapshot_net_worth', 'reconcile_balances', 'note_discovered_account')
  loop
    if not has_function_privilege('authenticated', f.sig, 'execute') then
      raise notice '% missing authenticated grant', f.sig;
      missing := true;
    end if;
  end loop;

  if missing then
    raise exception 'Not all required RPC functions have execute permission for authenticated role';
  end if;
  raise notice 'All internal RPC functions are now executable by authenticated role';
end
$$;
