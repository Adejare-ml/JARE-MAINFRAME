## 2024-05-18 - Avoid Math.random() for Identifiers
**Vulnerability:** Found `Math.random()` used to generate pseudo-random IDs in `src/pages/Projects.jsx` and `src/lib/toast.js`.
**Learning:** While generating UUIDs in the frontend without using cryptographic randomness is generally low-risk, using `crypto.randomUUID()` provides better uniqueness and avoids standard PRNG predictability issues.
**Prevention:** Use `crypto.randomUUID()` anywhere unique identifiers are generated in the application.

## 2025-02-05 - Missing Execution Grants for Revoked RPC Functions
**Vulnerability:** PostgreSQL `revoke execute on function <name> from public, anon;` inherently revokes execute for the `authenticated` role as well, since `authenticated` inherits from `public` in PostgREST. This leads to unexpected access denial for authenticated users if `grant execute on function <name> to authenticated;` is not explicitly declared afterward.
**Learning:** In Supabase, the best practice is to explicitly grant back execute permission to `authenticated` immediately after revoking from `public`. Not doing so causes silent permission failures that only manifest when authenticated front-ends attempt to call those RPCs.
**Prevention:** Whenever a migration revokes execute permissions from `public` or `anon`, verify that an explicit grant to `authenticated` is present. Write database-level migration verification blocks `do $$ ...` to assert `has_function_privilege('authenticated', ..., 'execute')`.
