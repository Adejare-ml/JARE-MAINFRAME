## 2024-05-18 - Avoid Math.random() for Identifiers
**Vulnerability:** Found `Math.random()` used to generate pseudo-random IDs in `src/pages/Projects.jsx` and `src/lib/toast.js`.
**Learning:** While generating UUIDs in the frontend without using cryptographic randomness is generally low-risk, using `crypto.randomUUID()` provides better uniqueness and avoids standard PRNG predictability issues.
**Prevention:** Use `crypto.randomUUID()` anywhere unique identifiers are generated in the application.

## 2024-05-24 - Missing Authenticated Role Execution Grants
**Vulnerability:** Found `REVOKE EXECUTE ON FUNCTION <func> FROM PUBLIC, anon;` used in migrations (e.g., `046_payee_aware_manual_match.sql`) without a corresponding `GRANT EXECUTE ON FUNCTION <func> TO authenticated;`.
**Learning:** In PostgreSQL, the `public` role encompasses all roles, including `authenticated`. Revoking from `public` without re-granting breaks legitimate frontend access to those RPC functions.
**Prevention:** Whenever `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC` is used to secure a Supabase RPC, ensure it is immediately followed by `GRANT EXECUTE ON FUNCTION ... TO authenticated;`.
