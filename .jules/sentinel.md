## 2024-05-18 - Avoid Math.random() for Identifiers
**Vulnerability:** Found `Math.random()` used to generate pseudo-random IDs in `src/pages/Projects.jsx` and `src/lib/toast.js`.
**Learning:** While generating UUIDs in the frontend without using cryptographic randomness is generally low-risk, using `crypto.randomUUID()` provides better uniqueness and avoids standard PRNG predictability issues.
**Prevention:** Use `crypto.randomUUID()` anywhere unique identifiers are generated in the application.

## 2026-10-24 - PostgreSQL RPC Public Execute by Default
**Vulnerability:** PostgreSQL RPC functions (`log_manual_transaction`, `log_wallet_transfer`, `correct_transaction`) were accessible to unauthorized execution because execute permissions were not explicitly revoked.
**Learning:** By default, PostgreSQL grants execute permissions to the `public` role for newly created functions, allowing anonymous or unauthorized authenticated users to potentially invoke them if exposed via PostgREST.
**Prevention:** Explicitly include `revoke execute on function <name> from public, anon;` for any new backend function created in Supabase migrations.
