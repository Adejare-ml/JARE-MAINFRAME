import { describe, it, expect } from 'vitest'
import { buildReminderDigest, toPushPayload, classifySendError, KIND_URLS, BODY_MAX, TITLE_MAX, PAYLOAD_MAX_BYTES } from '../src/lib/reminders.js'

const TODAY = '2026-08-08'

const bill = (date, overrides = {}) => ({
  type: 'debit',
  amount: 3000,
  transaction_date: date,
  recipient: 'Netflix',
  wallet_id: 'gt',
  category: 'Subscriptions',
  ...overrides,
})

describe('a quiet day', () => {
  it('is null, not an empty digest', () => {
    expect(buildReminderDigest({ today: TODAY })).toBeNull()
    expect(buildReminderDigest()).toBeNull()
  })

  it('ignores settled debts, done repairs and finished milestones', () => {
    const digest = buildReminderDigest({
      today: TODAY,
      debts: [{ id: 'a', kind: 'loan', direction: 'i_owe', counterparty: 'Tolu', due_date: TODAY, settled: true }],
      repairs: [{ id: 'r', item: 'Gen', priority: 'urgent', status: 'done' }],
      projects: [{ id: 'p', name: 'Site', status: 'active' }],
      milestones: [{ project_id: 'p', title: 'Ship', due_date: '2026-08-01', completed: true }],
    })
    expect(digest).toBeNull()
  })
})

describe('debts', () => {
  it('keeps overdue and due-soon loans, with the amount left', () => {
    const digest = buildReminderDigest({
      today: TODAY,
      debts: [
        { id: 'a', kind: 'loan', direction: 'i_owe', counterparty: 'Tolu', principal: 50000, amount_paid: 20000, due_date: '2026-08-10' },
        { id: 'b', kind: 'loan', direction: 'i_owe', counterparty: 'Ade', principal: 5000, due_date: '2026-08-01' },
        { id: 'c', kind: 'loan', direction: 'i_owe', counterparty: 'Far', principal: 5000, due_date: '2026-09-01' },
      ],
    })
    expect(digest.items.map((i) => i.text)).toEqual([
      'Ade: ₦5,000 due 7d overdue',
      'Tolu: ₦30,000 due in 2d',
    ])
    expect(digest.url).toBe(KIND_URLS.debt)
  })

  it('words a payout and a contribution differently from a loan', () => {
    const digest = buildReminderDigest({
      today: TODAY,
      debts: [
        { id: 'a', kind: 'ajo', counterparty: 'Office ajo', cycle_size: 12, cycle_position: 4, contribution: 20000, payout_date: TODAY, due_date: '2026-08-09' },
      ],
    })
    expect(digest.items.map((i) => i.text)).toEqual([
      'Office ajo: pot of ₦240,000 pays out today',
      'Office ajo: ₦20,000 contribution due in 1d',
    ])
  })
})

describe('bills', () => {
  const history = [bill('2026-05-08'), bill('2026-06-08'), bill('2026-07-08')]

  it('includes a recurring bill expected today', () => {
    const digest = buildReminderDigest({ today: TODAY, transactions: history })
    expect(digest.items).toHaveLength(1)
    expect(digest.items[0].kind).toBe('bill')
    expect(digest.items[0].text).toMatch(/^Netflix: ₦3,000 expected /)
  })

  it('includes an overdue one, and leaves one a week out alone', () => {
    expect(buildReminderDigest({ today: '2026-08-20', transactions: history }).items[0].text).toMatch(/overdue/)
    expect(buildReminderDigest({ today: '2026-07-20', transactions: history })).toBeNull()
  })
})

describe('repairs and milestones', () => {
  it('takes urgent or due repairs and open milestones past their date', () => {
    const digest = buildReminderDigest({
      today: TODAY,
      repairs: [
        { id: 'r1', item: 'Generator', priority: 'urgent', status: 'pending' },
        { id: 'r2', item: 'Tap', priority: 'soon', status: 'pending', due_date: '2026-08-05' },
        { id: 'r3', item: 'Paint', priority: 'someday', status: 'pending' },
      ],
      projects: [
        { id: 'p1', name: 'Site', status: 'active' },
        { id: 'p2', name: 'Old', status: 'complete' },
      ],
      milestones: [
        { project_id: 'p1', title: 'Ship v1', due_date: '2026-08-06', completed: false },
        { project_id: 'p2', title: 'Ignored', due_date: '2026-08-01', completed: false },
        { project_id: 'p1', title: 'Later', due_date: '2026-09-01', completed: false },
      ],
    })
    expect(digest.items.map((i) => i.text)).toEqual([
      'Generator: urgent',
      'Tap: soon, due 3d overdue',
      'Ship v1 (Site) 2d overdue',
    ])
    expect(digest.url).toBe('/')
  })
})

describe('the review queue', () => {
  it('comes last, as a count, and pluralises', () => {
    const one = buildReminderDigest({ today: TODAY, unreviewedCount: 1 })
    expect(one.items[0].text).toBe('1 transaction to review')
    expect(one.title).toBe('1 transaction to review')
    expect(one.url).toBe(KIND_URLS.review)

    const mixed = buildReminderDigest({
      today: TODAY,
      unreviewedCount: 4,
      debts: [{ id: 'a', kind: 'loan', direction: 'i_owe', counterparty: 'Tolu', principal: 100, due_date: TODAY }],
    })
    expect(mixed.items.at(-1).text).toBe('4 transactions to review')
    expect(mixed.title).toBe('2 things need you today')
    expect(mixed.body).toBe('Tolu: ₦100 due today · 4 transactions to review')
  })

  it('ignores a zero or malformed count', () => {
    expect(buildReminderDigest({ today: TODAY, unreviewedCount: 0 })).toBeNull()
    expect(buildReminderDigest({ today: TODAY, unreviewedCount: 'lots' })).toBeNull()
  })
})

describe('size', () => {
  it('keeps the title and body inside a push payload', () => {
    const debts = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      kind: 'loan',
      direction: 'i_owe',
      counterparty: `Counterparty number ${i} with a long name`,
      principal: 1000000,
      due_date: TODAY,
    }))
    const digest = buildReminderDigest({ today: TODAY, debts })
    expect(digest.items).toHaveLength(30)
    expect(digest.title.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(digest.body.length).toBeLessThanOrEqual(BODY_MAX)
    expect(digest.body.endsWith('…')).toBe(true)
  })
})

describe('toPushPayload', () => {
  it('sends only what the worker reads', () => {
    const digest = buildReminderDigest({ today: TODAY, unreviewedCount: 3 })
    expect(JSON.parse(toPushPayload(digest))).toEqual({
      title: '3 transactions to review',
      body: '3 transactions to review',
      url: '/transactions',
    })
  })

  it('never carries a url off the app', () => {
    expect(JSON.parse(toPushPayload({ title: 't', body: 'b', url: 'https://evil.example' })).url).toBe('/')
    expect(JSON.parse(toPushPayload({ title: 't', body: 'b' })).url).toBe('/')
  })

  it('stays well inside the push services\' cap', () => {
    const digest = buildReminderDigest({
      today: TODAY,
      debts: Array.from({ length: 40 }, (_, i) => ({
        id: String(i), kind: 'loan', direction: 'i_owe', counterparty: `Someone ${i}`, principal: 5000, due_date: TODAY,
      })),
    })
    expect(Buffer.byteLength(toPushPayload(digest), 'utf8')).toBeLessThan(PAYLOAD_MAX_BYTES)
  })
})

describe('classifySendError', () => {
  it('deletes only on the two "this subscription is gone" codes', () => {
    expect(classifySendError(404)).toBe('gone')
    expect(classifySendError(410)).toBe('gone')
  })

  it('keeps the row for anything that might be a bad morning', () => {
    for (const code of [400, 401, 403, 413, 429, 500, 502, 503, undefined, null]) {
      expect(classifySendError(code)).toBe('retry')
    }
  })
})
