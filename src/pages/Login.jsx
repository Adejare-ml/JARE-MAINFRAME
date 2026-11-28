import { useState } from 'react'
import { RESET_SENT_MESSAGE, isRateLimitError } from '../lib/auth'
import Panel from '../components/ui/Panel'
import Button from '../components/ui/Button'
import Label from '../components/ui/Label'
import StatusDot from '../components/ui/StatusDot'
import { Input } from '../components/ui/Field'

/**
 * Sign in, or ask for a reset link.
 *
 * The reset form says the same thing whether or not the address has an
 * account (src/lib/auth.js RESET_SENT_MESSAGE): a reply that differed
 * would let anyone probe which addresses are registered. The one
 * exception is Supabase's rate-limit refusal, which says nothing about
 * the address and is worth showing so a second tap is not mistaken for a
 * failed first one.
 *
 * @param {object} props
 * @param {(email: string, password: string) => Promise<{error: object|null}>} props.onLogin
 * @param {(email: string) => Promise<{error: object|null}>} [props.onReset]
 */
export default function Login({ onLogin, onReset }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [forgot, setForgot] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error } = await onLogin(email, password)
    if (error) {
      setError(error.message)
    }
    setLoading(false)
  }

  const handleReset = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await onReset(email)
    setLoading(false)
    if (error && isRateLimitError(error)) {
      setError(error.message)
      return
    }
    // Any other outcome reads the same: a real send, an unknown address,
    // or a transient failure the user cannot act on differently.
    setSent(true)
  }

  const showForgot = () => {
    setForgot(true)
    setSent(false)
    setError('')
    setPassword('')
  }

  const showSignIn = () => {
    setForgot(false)
    setSent(false)
    setError('')
  }

  const errorLine = error && (
    <p role="alert" className="flex items-start gap-2 text-body-sm text-danger">
      <StatusDot status="danger" className="mt-1.5" />
      <span>{error}</span>
    </p>
  )

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <Wordmark />

        {forgot ? (
          <Panel label="Reset password">
            <form onSubmit={handleReset} className="space-y-4">
              <div>
                <h2 className="text-title text-foreground">Forgot your password?</h2>
                <p className="text-body-sm text-muted mt-1">Enter your email and a reset link will be sent to it.</p>
              </div>

              {sent ? (
                <p role="status" className="flex items-start gap-2 text-body-sm text-foreground">
                  <StatusDot status="accent" className="mt-1.5" />
                  <span>{RESET_SENT_MESSAGE}</span>
                </p>
              ) : (
                <Input
                  id="reset-email"
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  autoComplete="email"
                  placeholder="your@email.com"
                />
              )}

              {errorLine}

              {!sent && (
                <Button type="submit" full loading={loading} disabled={!onReset}>
                  {loading ? 'Sending…' : 'Send reset link'}
                </Button>
              )}

              <Button variant="ghost" full icon="chevL" onClick={showSignIn}>
                Back to sign in
              </Button>
            </form>
          </Panel>
        ) : (
          <Panel label="Sign in">
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                id="email"
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="your@email.com"
              />

              <Input
                id="password"
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
              />

              {errorLine}

              <Button type="submit" full loading={loading} icon="lock">
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>

              {onReset && (
                <Button variant="ghost" full onClick={showForgot}>
                  Forgot password?
                </Button>
              )}
            </form>
          </Panel>
        )}

        <p className="text-center type-data text-muted-dim">Personal life operating system</p>
      </div>
    </div>
  )
}

/** The name, plainly: no glow, no accent bar. Shared look with ResetPassword. */
function Wordmark() {
  return (
    <div className="text-center space-y-1">
      <h1 className="text-title text-foreground">Jare</h1>
      <Label as="p">Mainframe</Label>
    </div>
  )
}
