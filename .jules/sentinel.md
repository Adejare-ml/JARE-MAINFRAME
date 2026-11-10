## 2024-05-18 - Avoid Math.random() for Identifiers
**Vulnerability:** Found `Math.random()` used to generate pseudo-random IDs in `src/pages/Projects.jsx` and `src/lib/toast.js`.
**Learning:** While generating UUIDs in the frontend without using cryptographic randomness is generally low-risk, using `crypto.randomUUID()` provides better uniqueness and avoids standard PRNG predictability issues.
**Prevention:** Use `crypto.randomUUID()` anywhere unique identifiers are generated in the application.
## 2024-05-19 - Revoking Postgres PUBLIC requires GRANT to AUTHENTICATED
**Vulnerability:** A previous security migration revoked execute from public/anon on newly created RPC functions, but failed to grant execute back to the authenticated role.
**Learning:** In PostgreSQL, the `public` role encompasses all roles, including `authenticated`. Revoking from `public` without re-granting breaks legitimate frontend access via PostgREST.
**Prevention:** Always pair `revoke execute on function ... from public, anon;` with `grant execute on function ... to authenticated;` when securing Supabase RPCs intended for frontend use.
