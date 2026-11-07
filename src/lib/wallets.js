/**
 * What an edit of a wallet in Settings is allowed to write.
 *
 * The edit sheet loads the balance once, when it opens, and used to send
 * it back on every save. A sheet opened before the morning audit and saved
 * after it put the old balance back, which the reconciliation then reported
 * as drift against the bank. So the balance goes in the payload only when
 * the owner typed a different one, and then with `balance_as_of` stamped
 * now, so the ingest function's "never backwards" guard (036/043:
 * `balance_as_of <= v_at`) treats a hand-set balance like a stated one.
 *
 * Pure: form and row in, update payload out.
 */

/** Local time as the text form the ingest function writes: YYYY-MM-DDTHH:MM:SS. */
export function localTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * @param {{name: string, type: string, balance: string|number, alert_sender?: string, account_last4?: string, color?: string, is_active?: boolean, parse_strategy?: string}} form
 * @param {{balance?: number|string|null}|null} [existing] - the wallet row the sheet was opened on; null for a new wallet
 * @param {Date} [now]
 * @returns {{payload: object, balanceChanged: boolean}}
 */
export function walletUpdatePayload(form, existing = null, now = new Date()) {
  const payload = {
    name: String(form.name || '').trim(),
    type: form.type,
    currency: 'NGN',
    alert_sender: String(form.alert_sender || '').trim() || null,
    account_last4: String(form.account_last4 || '').trim() || null,
    color: form.color,
    is_active: form.is_active,
    parse_strategy: form.parse_strategy,
  }

  const typed = String(form.balance ?? '').trim()
  const typedNumber = typed === '' ? null : Number(typed)
  const current = existing ? Number(existing.balance) || 0 : null

  // A new wallet always gets a balance (0 when the field was left blank).
  if (!existing) {
    payload.balance = Number.isFinite(typedNumber) ? typedNumber : 0
    return { payload, balanceChanged: true }
  }

  // An edit sends the balance only when the owner typed a different one. A
  // blank field means "leave it", not "zero it".
  const balanceChanged = Number.isFinite(typedNumber) && Math.abs(typedNumber - current) >= 0.005
  if (balanceChanged) {
    payload.balance = typedNumber
    payload.balance_as_of = localTimestamp(now)
  }
  return { payload, balanceChanged }
}
