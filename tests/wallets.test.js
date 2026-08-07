import { describe, it, expect } from 'vitest'
import {
  getParseStrategy,
  buildWalletIndex,
  matchWallet,
  walletSource,
} from '../src/lib/sync/wallets.js'

const WALLETS = [
  { id: 'w1', name: 'GTBank', alert_sender: 'GeNS@gtbank.com', is_active: true, parse_strategy: 'auto' },
  { id: 'w2', name: 'Opay', alert_sender: 'no-reply@opay-nigeria.com', is_active: true, parse_strategy: 'llm' },
  { id: 'w3', name: 'Zenith', alert_sender: 'ebusinessgroup@zenithbank.com', is_active: true },
  { id: 'w4', name: 'Cash', alert_sender: null, is_active: true },
  { id: 'w5', name: 'Old Bank', alert_sender: 'old@dead.com', is_active: false },
]

describe('getParseStrategy', () => {
  it('honours an explicit strategy', () => {
    expect(getParseStrategy({ parse_strategy: 'llm' })).toBe('llm')
    expect(getParseStrategy({ parse_strategy: 'rules' })).toBe('rules')
    expect(getParseStrategy({ parse_strategy: 'AUTO' })).toBe('auto')
  })

  it('defaults to auto for an ordinary bank', () => {
    expect(getParseStrategy({ name: 'GTBank', alert_sender: 'GeNS@gtbank.com' })).toBe('auto')
    expect(getParseStrategy({})).toBe('auto')
  })

  // If the migration has not run, or a wallet predates the column, Opay must
  // still not be handed to the rules parser -- its direction is not recoverable
  // from wording, and a wrong direction corrupts the monthly totals.
  it('infers llm for providers whose direction rules cannot be trusted', () => {
    expect(getParseStrategy({ name: 'Opay' })).toBe('llm')
    expect(getParseStrategy({ name: 'PiggyVest', alert_sender: 'contact@piggyvest.com' })).toBe('llm')
    expect(getParseStrategy({ name: 'Wallet', alert_sender: 'no-reply@opay-nigeria.com' })).toBe('llm')
  })

  it('lets an explicit value override the inference', () => {
    expect(getParseStrategy({ name: 'Opay', parse_strategy: 'rules' })).toBe('rules')
  })

  it('ignores a strategy value it does not recognise', () => {
    expect(getParseStrategy({ name: 'GTBank', parse_strategy: 'magic' })).toBe('auto')
  })
})

describe('buildWalletIndex', () => {
  it('indexes active wallets that have a sender', () => {
    const index = buildWalletIndex(WALLETS)

    expect(index.senders).toEqual([
      'gens@gtbank.com',
      'no-reply@opay-nigeria.com',
      'ebusinessgroup@zenithbank.com',
    ])
  })

  it('skips inactive wallets, so a disabled bank stops being searched', () => {
    expect(buildWalletIndex(WALLETS).senders).not.toContain('old@dead.com')
  })

  it('skips wallets with no sender', () => {
    expect(buildWalletIndex(WALLETS).byAddress.has('')).toBe(false)
    expect(buildWalletIndex(WALLETS).senders).toHaveLength(3)
  })

  it('handles an empty or missing list', () => {
    expect(buildWalletIndex([]).senders).toEqual([])
    expect(buildWalletIndex(null).senders).toEqual([])
  })

  it('does not let a later wallet steal an earlier one’s domain', () => {
    const index = buildWalletIndex([
      { id: 'a', name: 'Main', alert_sender: 'alerts@bank.com' },
      { id: 'b', name: 'Second', alert_sender: 'other@bank.com' },
    ])
    expect(index.byDomain.get('bank.com').id).toBe('a')
  })
})

describe('matchWallet', () => {
  const index = buildWalletIndex(WALLETS)

  it('matches on the exact sender address', () => {
    expect(matchWallet('gens@gtbank.com', index).id).toBe('w1')
    expect(matchWallet('GeNS@GTBank.com', index).id).toBe('w1')
  })

  it('falls back to the sending domain', () => {
    // Banks rotate the local part; the domain is the stable signal.
    expect(matchWallet('alerts2@gtbank.com', index).id).toBe('w1')
  })

  it('returns null for an unknown sender', () => {
    expect(matchWallet('random@example.com', index)).toBeNull()
    expect(matchWallet('', index)).toBeNull()
    expect(matchWallet(null, index)).toBeNull()
  })
})

describe('walletSource', () => {
  it('derives a stable slug from the wallet name', () => {
    expect(walletSource({ name: 'GTBank' })).toBe('gtbank')
    expect(walletSource({ name: 'Zenith Bank' })).toBe('zenith_bank')
    expect(walletSource({ name: '  Polaris  ' })).toBe('polaris')
  })

  it('falls back to "email" when there is no wallet', () => {
    expect(walletSource(null)).toBe('email')
    expect(walletSource({})).toBe('email')
  })
})
