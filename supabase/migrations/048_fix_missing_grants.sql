-- ============================================================================
-- 048_fix_missing_grants.sql
--
-- Migration 046 revoked execution from public and anon but omitted the required
-- grants to authenticated for jare_payee_words and jare_texts_share_word.
-- ============================================================================

grant execute on function jare_payee_words(text) to authenticated;
grant execute on function jare_texts_share_word(text, text) to authenticated;
