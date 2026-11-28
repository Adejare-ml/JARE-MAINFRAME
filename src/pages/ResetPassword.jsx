import { useState } from 'react'
import { validateNewPassword, PASSWORD_MIN } from '../lib/auth'
import { toast } from '../lib/toast'
import Panel from '../components/ui/Panel'
import Button from '../components/ui/Button'
import Label from '../components/ui/Label'
import StatusDot from '../components/ui/StatusDot'
import { Input } from '../components/ui/Field'

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
    toast.success('Password updated')
    onDone()
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-title text-foreground">Jare</h1>
          <Label as="p">Mainframe</Label>
        </div>

        {expired ? (
          <Panel label="Reset link" tone="warn">
            <div className="space-y-4">
              <div>
                <h2 className="flex items-center gap-2 text-title text-foreground">
                  <StatusDot status="warn" />
                  This link has expired
                </h2>
                <p className="text-body-sm text-muted mt-1">
                  Reset links work once and for about an hour. Ask for a new one from the sign-in page.
                </p>
              </div>
              <Button full icon="chevL" onClick={onCancel}>
                Back to sign in
              </Button>
            </div>
          </Panel>
        ) : (
          <Panel label="New password">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <h2 className="text-title text-foreground">Choose a new password</h2>
                <p className="text-body-sm text-muted mt-1">
                  At least {PASSWORD_MIN} characters. You will stay signed in on this device.
                </p>
              </div>

              <Input
                id="new-password"
                label="New password"
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
                placeholder="••••••••"
              />

              <Input
                id="confirm-password"
                label="Once more"
                type="password"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value)
                  if (error) setError('')
                }}
                required
                autoComplete="new-password"
                minLength={PASSWORD_MIN}
                placeholder="••••••••"
              />

              {error && (
                <p role="alert" className="flex items-start gap-2 text-body-sm text-danger">
                  <StatusDot status="danger" className="mt-1.5" />
                  <span>{error}</span>
                </p>
              )}

              <Button type="submit" full loading={saving}>
                {saving ? 'Saving…' : 'Save password'}
              </Button>

              <Button variant="ghost" full onClick={onCancel}>
                Cancel and go back to sign in
              </Button>
            </form>
          </Panel>
        )}
      </div>
    </div>
  )
}
