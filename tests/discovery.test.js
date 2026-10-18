import { describe, it, expect } from 'vitest'
import {
  slugFromSender,
  labelFromSender,
  suggestWalletType,
  awaitingDecision,
  dueToAsk,
  discoveryItems,
  describeDiscovered,
  walletFromDiscovered,
  NAG_EVERY_DAYS,
  DISCOVERY_URL,
} from '../src/lib/discovery.js'
import { buildReminderDigest, KIND_URLS } from '../src/lib/reminders.js'

const TODAY = '2026-10-18'
const row = (over = {}) => ({
  id: 'd1',
  slug: 'kuda',
  sender: 'Kuda <no-reply@kuda.com>',
  label: 'Kuda',
  status: 'new',
  last_balance: 12400,
  last_seen_on: '2026-10-17',
  first_seen_at: '2026-10-18T06:00:00Z',
  times_seen: 1,
  ...over,
})

describe('slugFromSender', () => {
  it('takes the domain word from an address and drops generic prefixes and TLDs', () => {
    expect(slugFromSender('no-reply@kuda.com')).toBe('kuda')
    expect(slugFromSender('alerts@mail.moniepoint.com')).toBe('moniepoint')
    expect(slugFromSender('Notify <notify@ng.fairmoney.io>')).toBe('fairmoney')
    expect(slugFromSender('ebusinessgroup@zenithbank.com')).toBe('zenithbank')
    expect(slugFromSender('x@gtbank.com.ng')).toBe('gtbank')
  })
  it('takes the first meaningful word of a bank name', () => {
    expect(slugFromSender('Fairmoney Microfinance Bank')).toBe('fairmoney')
    expect(slugFromSender('The Polaris Bank Ltd')).toBe('polaris')
    expect(slugFromSender('')).toBe('')
  })
})

describe('labelFromSender and suggestWalletType', () => {
  it('prefers the display name, else capitalises the slug', () => {
    expect(labelFromSender('Kuda <no-reply@kuda.com>')).toBe('Kuda')
    expect(labelFromSender('no-reply@moniepoint.com')).toBe('Moniepoint')
    expect(labelFromSender('', 'Unknown')).toBe('Unknown')
  })
  it('guesses the wallet type from the slug', () => {
    expect(suggestWalletType('kuda')).toBe('mobile')
    expect(suggestWalletType('palmpay')).toBe('mobile')
    expect(suggestWalletType('piggyvest')).toBe('savings')
    expect(suggestWalletType('risevest')).toBe('investment')
    expect(suggestWalletType('polaris')).toBe('bank')
  })
})

describe('asking the owner', () => {
  it('lists only undecided rows, oldest first', () => {
    const list = awaitingDecision([
      row({ id: 'b', first_seen_at: '2026-10-12T00:00:00Z' }),
      row({ id: 'x', status: 'ignored' }),
      row({ id: 'a', first_seen_at: '2026-10-10T00:00:00Z' }),
      row({ id: 'y', status: 'tracking' }),
    ])
    expect(list.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('asks on the first day and then weekly, never daily', () => {
    expect(dueToAsk(row({ first_seen_at: '2026-10-18T05:00:00Z' }), TODAY)).toBe(true)
    expect(dueToAsk(row({ first_seen_at: '2026-10-17T05:00:00Z' }), TODAY)).toBe(false)
    expect(dueToAsk(row({ first_seen_at: '2026-10-11T05:00:00Z' }), TODAY)).toBe(true)
    expect(dueToAsk(row({ first_seen_at: '2026-10-04T05:00:00Z' }), TODAY)).toBe(true)
    expect(dueToAsk(row({ first_seen_at: null }), TODAY)).toBe(true)
    expect(NAG_EVERY_DAYS).toBe(7)
  })

  it('writes the digest line with the balance and when it was seen', () => {
    const items = discoveryItems([row()], TODAY)
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('account')
    expect(items[0].text).toBe('New account in your mail: Kuda, ₦12,400 yesterday. Track it?')
    expect(items[0].url).toBe(DISCOVERY_URL)
  })

  it('rides the morning digest and lands on Settings', () => {
    const digest = buildReminderDigest({ today: TODAY, discoveredAccounts: [row()] })
    expect(digest.title).toMatch(/New account in your mail: Kuda/)
    expect(digest.url).toBe(KIND_URLS.account)
    expect(buildReminderDigest({ today: TODAY, discoveredAccounts: [row({ status: 'ignored' })] })).toBeNull()
  })
})

describe('describeDiscovered and walletFromDiscovered', () => {
  it('describes a row in one line', () => {
    expect(describeDiscovered(row({ times_seen: 4, last_seen_on: '2026-10-15' }), TODAY)).toBe('Kuda · last seen 3 days ago · ₦12,400 · 4 alerts')
    expect(describeDiscovered(row({ last_balance: null, last_seen_on: TODAY }), TODAY)).toBe('Kuda · seen today')
  })
  it('builds the wallet the owner is about to create', () => {
    const w = walletFromDiscovered(row(), { type: 'bank' })
    expect(w).toEqual({ name: 'Kuda', type: 'bank', source_slug: 'kuda', alert_sender: 'no-reply@kuda.com', balance: 12400, parse_strategy: 'llm' })
    expect(walletFromDiscovered(row({ label: null, sender: 'x@moniepoint.com', slug: 'moniepoint', last_balance: null })).type).toBe('mobile')
    expect(walletFromDiscovered(row({ sender: null, last_balance: null })).alert_sender).toBeNull()
  })
})
