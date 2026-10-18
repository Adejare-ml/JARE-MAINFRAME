## 2024-05-18 - Avoid Math.random() for Identifiers
**Vulnerability:** Found `Math.random()` used to generate pseudo-random IDs in `src/pages/Projects.jsx` and `src/lib/toast.js`.
**Learning:** While generating UUIDs in the frontend without using cryptographic randomness is generally low-risk, using `crypto.randomUUID()` provides better uniqueness and avoids standard PRNG predictability issues.
**Prevention:** Use `crypto.randomUUID()` anywhere unique identifiers are generated in the application.
