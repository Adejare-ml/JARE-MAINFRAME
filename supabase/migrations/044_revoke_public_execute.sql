-- ============================================================================
-- 044_revoke_public_execute.sql
--
-- Three browser-called RPCs from the early migrations (002/029, 007, 028)
-- were granted to authenticated but never had Postgres's default EXECUTE
-- for PUBLIC revoked, so anon could reach them through PostgREST. Every
-- table policy is role authenticated with auth.uid() = user_id and all
-- three are SECURITY INVOKER, so an anon call wrote nothing; this closes
-- the door the convention says should never have been open (council
-- review of 18 Oct, LIVE-ANON-EXECUTE). Signatures are the live ones:
-- 029 replaced the nine-argument log_manual_transaction with the ten-
-- argument form that carries p_debt_id, so only that one exists.
-- ============================================================================

revoke execute on function log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time, uuid) from public, anon;
revoke execute on function correct_transaction(uuid, text, numeric, date, text, text, text, boolean) from public, anon;
revoke execute on function log_wallet_transfer(text, uuid, uuid, numeric, text, text, text, date, time) from public, anon;

grant execute on function log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time, uuid) to authenticated;
grant execute on function correct_transaction(uuid, text, numeric, date, text, text, text, boolean) to authenticated;
grant execute on function log_wallet_transfer(text, uuid, uuid, numeric, text, text, text, date, time) to authenticated;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('log_manual_transaction', 'correct_transaction', 'log_wallet_transfer')
  loop
    if has_function_privilege('anon', f.sig, 'execute') then
      raise exception '% is still executable by anon', f.sig;
    end if;
    if not has_function_privilege('authenticated', f.sig, 'execute') then
      raise exception '% lost its authenticated grant', f.sig;
    end if;
  end loop;
  raise notice 'anon can no longer execute the three manual-entry RPCs';
end
$$;
