-- ============================================================================
-- 044_revoke_public_execute.sql
--
-- Explicitly revoke execute permissions from public and anon roles on
-- PostgreSQL RPC functions to prevent unauthorized execution.
-- By default, PostgreSQL grants execute permissions to the public role.
-- ============================================================================

revoke execute on function log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time, uuid) from public, anon;
revoke execute on function log_wallet_transfer(text, uuid, uuid, numeric, text, text, text, date, time) from public, anon;
revoke execute on function correct_transaction(uuid, text, numeric, date, text, text, text, boolean) from public, anon;

grant execute on function log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time, uuid) to authenticated;
grant execute on function log_wallet_transfer(text, uuid, uuid, numeric, text, text, text, date, time) to authenticated;
grant execute on function correct_transaction(uuid, text, numeric, date, text, text, text, boolean) to authenticated;
