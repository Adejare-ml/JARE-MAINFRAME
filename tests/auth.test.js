import { describe, it, expect } from 'vitest'
import {
  isRecoveryUrl,
  validateNewPassword,
  isRateLimitError,
  PASSWORD_MIN,
  RECOVERY_PATH,
  RESET_SENT_MESSAGE,
} from '../src/lib/auth.js'

describe('isRecoveryUrl', () => {
  it('recognises the PKCE landing: the reset path with a code', () => {
    expect(isRecoveryUrl({ pathname: RECOVERY_PATH, search: '?code=abc123', hash: '' })).toBe(true)
    expect(isRecoveryUrl(`https://jare-mainframe.pages.dev${RECOVERY_PATH}?code=abc123`)).toBe(true)
  })

  it('recognises the implicit landing: a hash with type=recovery', () => {
    expect(isRecoveryUrl({ pathname: '/', search: '', hash: '#access_token=x&type=recovery&expires_in=3600' })).toBe(true)
    expect(isRecoveryUrl('https://jare-mainframe.pages.dev/#type=recovery')).toBe(true)
  })

  it('is false for the reset path without a code, and for other pages', () => {
    expect(isRecoveryUrl({ pathname: RECOVERY_PATH, search: '', hash: '' })).toBe(false)
    expect(isRecoveryUrl({ pathname: '/', search: '?code=abc', hash: '' })).toBe(false)
    expect(isRecoveryUrl({ pathname: '/budget', search: '?month=2026-07', hash: '' })).toBe(false)
    // A different type in the hash is a different flow.
    expect(isRecoveryUrl({ pathname: '/', search: '', hash: '#type=signup' })).toBe(false)
    expect(isRecoveryUrl({ pathname: '/', search: '', hash: '#mytype=recovery' })).toBe(false)
  })

  it('survives nothing and garbage', () => {
    expect(isRecoveryUrl(null)).toBe(false)
    expect(isRecoveryUrl(undefined)).toBe(false)
    expect(isRecoveryUrl('')).toBe(false)
    expect(isRecoveryUrl({})).toBe(false)
  })
})

describe('validateNewPassword', () => {
  it('accepts a matching pair at the minimum length', () => {
    const pw = 'x'.repeat(PASSWORD_MIN)
    expect(validateNewPassword(pw, pw)).toEqual({ ok: true })
  })

  it('refuses a blank', () => {
    expect(validateNewPassword('', '').ok).toBe(false)
    expect(validateNewPassword(undefined, undefined).ok).toBe(false)
  })

  it('refuses one shorter than the floor', () => {
    const pw = 'x'.repeat(PASSWORD_MIN - 1)
    const result = validateNewPassword(pw, pw)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(String(PASSWORD_MIN))
  })

  it('refuses a mismatch, and does not trim', () => {
    expect(validateNewPassword('longenough1', 'longenough2').ok).toBe(false)
    expect(validateNewPassword('longenough1', 'longenough1 ').ok).toBe(false)
  })
})

describe('the forgot-password reply', () => {
  it('never says whether the address exists', () => {
    expect(RESET_SENT_MESSAGE).toMatch(/If that address has an account/)
  })

  it('lets a rate-limit refusal through, and nothing else', () => {
    expect(isRateLimitError({ status: 429, message: 'x' })).toBe(true)
    expect(isRateLimitError({ message: 'For security purposes, you can only request this after 42 seconds.' })).toBe(true)
    expect(isRateLimitError({ status: 400, message: 'User not found' })).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
  })
})
