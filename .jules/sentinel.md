## 2024-05-18 - Avoid Math.random() for Identifiers
**Vulnerability:** Found `Math.random()` used to generate pseudo-random IDs in `src/pages/Projects.jsx` and `src/lib/toast.js`.
**Learning:** While generating UUIDs in the frontend without using cryptographic randomness is generally low-risk, using `crypto.randomUUID()` provides better uniqueness and avoids standard PRNG predictability issues.
**Prevention:** Use `crypto.randomUUID()` anywhere unique identifiers are generated in the application.
## 2025-03-09 - Missing Explicit EXECUTE Revocation on RPC Functions
**Vulnerability:** Several sensitive PostgreSQL RPC functions (`log_manual_transaction`, `correct_transaction`, `log_wallet_transfer`) lacked explicit `revoke execute from public, anon` statements. By default, PostgreSQL grants EXECUTE privilege on new functions to the `public` role.
**Learning:** In Supabase, relying on default function permissions can unintentionally expose backend logic to unauthenticated users, even if `SECURITY INVOKER` is used, depending on the RLS policies in place. The codebase had corrected this for newer functions but left older ones vulnerable.
**Prevention:** Always append `revoke execute on function <name> from public, anon;` followed by explicit `grant execute on function <name> to authenticated;` when defining new RPCs.
