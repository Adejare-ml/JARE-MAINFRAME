import { describe, it, expect } from 'vitest'
import { walletUpdatePayload, localTimestamp } from '../src/lib/wallets.js'

const NOW = new Date(2026, 10, 7, 9, 30, 15) // 7 Nov 2026 09:30:15 local
const form = (over = {}) => ({
  name: ' GTBank ',
  type: 'bank',
  balance: '15200',
  alert_sender: 'gens@gtbank.com ',
  account_last4: '',
  color: '#22c55e',
  is_active: true,
  parse_strategy: 'auto',
  ...over,
})

describe('walletUpdatePayload', () => {
  it('leaves the balance out of an edit when the owner did not change it', () => {
    const { payload, balanceChanged } = walletUpdatePayload(form(), { balance: 15200 }, NOW)
    expect(balanceChanged).toBe(false)
    expect(payload).not.toHaveProperty('balance')
    expect(payload).not.toHaveProperty('balance_as_of')
    expect(payload.name).toBe('GTBank')
    expect(payload.alert_sender).toBe('gens@gtbank.com')
    expect(payload.account_last4).toBeNull()
  })

  it('sends a changed balance with a fresh balance_as_of so the ingest guard respects it', () => {
    const { payload, balanceChanged } = walletUpdatePayload(form({ balance: '18400' }), { balance: 15200 }, NOW)
    expect(balanceChanged).toBe(true)
    expect(payload.balance).toBe(18400)
    expect(payload.balance_as_of).toBe('2026-11-07T09:30:15')
  })

  it('treats a blank field on an edit as "leave it", and a kobo difference as a change', () => {
    expect(walletUpdatePayload(form({ balance: '' }), { balance: 15200 }, NOW).balanceChanged).toBe(false)
    expect(walletUpdatePayload(form({ balance: '15200.01' }), { balance: 15200 }, NOW).balanceChanged).toBe(true)
    expect(walletUpdatePayload(form({ balance: '15200.001' }), { balance: 15200 }, NOW).balanceChanged).toBe(false)
  })

  it('always gives a new wallet a balance, zero when blank', () => {
    expect(walletUpdatePayload(form({ balance: '' }), null, NOW).payload.balance).toBe(0)
    expect(walletUpdatePayload(form({ balance: '500' }), null, NOW).payload.balance).toBe(500)
    expect(walletUpdatePayload(form({ balance: '500' }), null, NOW).payload).not.toHaveProperty('balance_as_of')
  })
})

describe('localTimestamp', () => {
  it('writes local time without a zone, the form the ingest function compares', () => {
    expect(localTimestamp(new Date(2026, 0, 5, 7, 4, 9))).toBe('2026-01-05T07:04:09')
  })
})
