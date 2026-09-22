import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveOwnerUserId } from '../scripts/lib/ownerId.mjs'

function clientWith(users, error = null) {
  const calls = []
  return {
    calls,
    auth: {
      admin: {
        listUsers: async (opts) => {
          calls.push(opts)
          return { data: { users }, error }
        },
      },
    },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('resolveOwnerUserId', () => {
  it('honours an explicit id without touching auth.users', async () => {
    const client = clientWith([{ id: 'someone-else' }])
    await expect(resolveOwnerUserId(client, 'explicit-id')).resolves.toBe('explicit-id')
    expect(client.calls).toHaveLength(0)
  })

  it('treats a blank secret as unset -- GitHub renders an unset secret as an empty string', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const client = clientWith([{ id: 'only-one', email: 'me@example.com' }])
    await expect(resolveOwnerUserId(client, '   ')).resolves.toBe('only-one')
    expect(client.calls).toHaveLength(1)
  })

  it('uses the only account when the secret is unset, and says so', async () => {
    const logs = []
    vi.spyOn(console, 'log').mockImplementation((line) => logs.push(line))
    const client = clientWith([{ id: 'only-one', email: 'me@example.com' }])
    await expect(resolveOwnerUserId(client, undefined)).resolves.toBe('only-one')
    expect(logs.join('\n')).toContain('me@example.com')
  })

  it('asks for only enough rows to detect ambiguity', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const client = clientWith([{ id: 'only-one' }])
    await resolveOwnerUserId(client, undefined)
    expect(client.calls[0]).toEqual({ page: 1, perPage: 2 })
  })

  it('refuses when there is no account at all', async () => {
    const client = clientWith([])
    await expect(resolveOwnerUserId(client, undefined)).rejects.toThrow(/OWNER_USER_ID.*empty/)
  })

  it('refuses when the owner is ambiguous rather than picking one', async () => {
    const client = clientWith([{ id: 'a' }, { id: 'b' }])
    await expect(resolveOwnerUserId(client, undefined)).rejects.toThrow(/OWNER_USER_ID.*more than one account/)
  })

  it('surfaces a lookup failure instead of treating it as "no users"', async () => {
    const client = clientWith([], { message: 'permission denied' })
    await expect(resolveOwnerUserId(client, undefined)).rejects.toThrow(/permission denied/)
  })
})
