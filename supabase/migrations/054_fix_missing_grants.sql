-- ============================================================================
-- 054_fix_missing_grants.sql
--
-- Restores execute privileges on RPC functions that were revoked from public/anon
-- but accidentally left un-granted to authenticated. This ensures the frontend
-- can execute these functions on behalf of an authenticated user.
-- ============================================================================

grant execute on function log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time, uuid) to authenticated;
grant execute on function log_wallet_transfer(text, uuid, uuid, numeric, text, text, text, date, time) to authenticated;
grant execute on function jare_payee_words(text) to authenticated;
grant execute on function jare_texts_share_word(text, text) to authenticated;
