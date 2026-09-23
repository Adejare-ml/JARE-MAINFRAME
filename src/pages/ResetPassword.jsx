import { useState } from 'react'
import { validateNewPassword, PASSWORD_MIN } from '../lib/auth'
import { toast } from '../lib/toast'

/**
 * Where the reset link lands. The client has already exchanged the link's
 * code for a session by the time this renders (useAuth's `recovering`), so
 * the only job here is to take a new password twice, check it, and save
 * it. Inline error next to the field, the Debts form's pattern.
 *
 * @param {object} props
 * @param {(password: string) => Promise<{error: object|null}>} props.onUpdate
 * @param {() => void} props.onDone - called after a successful save
 * @param {() => void} props.onCancel - back to the sign-in page, for a link
 *   opened by mistake
 * @param {boolean} [props.expired] - the link produced no session: it was
 *   used already, or its hour ran out
 */
export default function ResetPassword({ onUpdate, onDone, onCancel, expired = false }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    const checked = validateNewPassword(password, confirm)
    if (!checked.ok) {
      setError(checked.error)
      return
    }
    setError('')
    setSaving(true)
    const { error: saveError } = await onUpdate(password)
    setSaving(false)
    if (saveError) {
      setError(saveError.message || 'Could not save the new password')
      return
    }
    toast.success('Password updated ✓')
    onDone()
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold text-white tracking-tight mb-2">
            <span className="text-accent">J</span>are
          </h1>
          <p className="text-sm text-muted tracking-widest uppercase">Mainframe</p>
          <div className="mt-4 h-0.5 w-12 bg-accent mx-auto rounded-full" />
        </div>

        {expired ? (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-bold text-white">This link has expired</h2>
              <p className="text-xs text-muted mt-1">
                Reset links work once and for about an hour. Ask for a new one from the sign-in page.
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="w-full py-3.5 bg-accent hover:bg-accent/90 text-black font-semibold rounded-xl transition-all duration-200 active:scale-[0.98] min-h-[48px]"
            >
              Back to sign in
            </button>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <h2 className="text-lg font-bold text-white">Choose a new password</h2>
            <p className="text-xs text-muted mt-1">At least {PASSWORD_MIN} characters. You will stay signed in on this device.</p>
          </div>

          <div>
            <label htmlFor="new-password" className="block text-sm font-medium text-muted mb-2">
              New password
            </label>
            <input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                if (error) setError('')
              }}
              required
              autoFocus
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white placeholder-hint focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all duration-200 min-h-[48px]"
              placeholder="••••••••"
            />
          </div>

          <div>
            <label htmlFor="confirm-password" className="block text-sm font-medium text-muted mb-2">
              Once more
            </label>
            <input
              id="confirm-password"
              type="password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value)
                if (error) setError('')
              }}
              required
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white placeholder-hint focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all duration-200 min-h-[48px]"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div role="alert" className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full py-3.5 bg-accent hover:bg-accent/90 text-black font-semibold rounded-xl transition-all duration-200 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed min-h-[48px]"
          >
            {saving ? 'Saving…' : 'Save password'}
          </button>

          <button
            type="button"
            onClick={onCancel}
            className="w-full py-3 text-sm text-muted hover:text-white min-h-[44px]"
          >
            Cancel and go back to sign in
          </button>
        </form>
        )}
      </div>
    </div>
  )
}
