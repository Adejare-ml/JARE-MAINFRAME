-- ============================================================================
-- 044_revoke_public_execute.sql
--
-- Earlier migrations created several RPC functions (log_manual_transaction,
-- correct_transaction, log_wallet_transfer) and granted them to authenticated.
-- However, PostgreSQL grants EXECUTE to public by default on new functions.
-- This migration explicitly revokes EXECUTE from public (and anon) so they
-- cannot be called unauthenticated.
-- ============================================================================

revoke execute on function log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time) from public, anon;
revoke execute on function log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time, uuid) from public, anon;
revoke execute on function correct_transaction(uuid, text, numeric, date, text, text, text, boolean) from public, anon;
revoke execute on function log_wallet_transfer(text, uuid, uuid, numeric, text, text, text, date, time) from public, anon;
