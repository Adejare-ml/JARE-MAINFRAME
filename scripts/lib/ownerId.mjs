/**
 * Whose rows a scheduled script writes.
 *
 * Every script runs with the service-role key, which bypasses RLS and has no
 * `auth.uid()`, so `user_id` is supplied by hand -- and since 017 a row
 * without one is refused outright. The value used to come only from the
 * OWNER_USER_ID secret, which sat blank and undocumented for five weeks while
 * every scheduled job died on its first line. With exactly one account the
 * answer is knowable without a secret (014_claim_rows.sql resolves it the
 * same way); an ambiguous answer is still a refusal, because guessing wrong
 * would be the vanishing-rows failure again, one table at a time.
 *
 * @param {object} supabase - a service-role client; auth.admin needs it
 * @param {string|undefined} [explicit] - the secret's value, if any
 * @returns {Promise<string>} the owner's auth.users id
 */
export async function resolveOwnerUserId(supabase, explicit = process.env.OWNER_USER_ID) {
  const fromEnv = typeof explicit === 'string' ? explicit.trim() : ''
  if (fromEnv) return fromEnv

  // Two rows is enough: one means "use it", two means "cannot tell".
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 2 })
  if (error) {
    throw new Error(
      `Missing required environment variables: OWNER_USER_ID -- and auth.users could not be read to infer it (${error.message})`,
    )
  }

  const users = data?.users ?? []
  if (users.length === 1) {
    const [owner] = users
    console.log(`👤 OWNER_USER_ID is unset; using the only account, ${owner.email || owner.id}`)
    return owner.id
  }
  if (users.length === 0) {
    throw new Error(
      'Missing required environment variables: OWNER_USER_ID -- auth.users is empty, so there is nobody to write rows for. Sign in to the app once, or set the secret.',
    )
  }
  throw new Error(
    'Missing required environment variables: OWNER_USER_ID -- auth.users holds more than one account, so the owner cannot be inferred. Set the secret:  select id, email from auth.users;',
  )
}
