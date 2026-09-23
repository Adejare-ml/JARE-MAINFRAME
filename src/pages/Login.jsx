import { useState } from 'react'
import { RESET_SENT_MESSAGE, isRateLimitError } from '../lib/auth'

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

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold text-white tracking-tight mb-2">
            <span className="text-accent">J</span>are
          </h1>
          <p className="text-sm text-muted tracking-widest uppercase">Mainframe</p>
          <div className="mt-4 h-0.5 w-12 bg-accent mx-auto rounded-full" />
        </div>

        {forgot ? (
          <form onSubmit={handleReset} className="space-y-5">
            <div>
              <h2 className="text-lg font-bold text-white">Forgot your password?</h2>
              <p className="text-xs text-muted mt-1">Enter your email and a reset link will be sent to it.</p>
            </div>

            {sent ? (
              <div role="status" className="bg-accent/10 border border-accent/30 rounded-xl px-4 py-3 text-sm text-white/90">
                {RESET_SENT_MESSAGE}
              </div>
            ) : (
              <div>
                <label htmlFor="reset-email" className="block text-sm font-medium text-muted mb-2">
                  Email
                </label>
                <input
                  id="reset-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  autoComplete="email"
                  className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white placeholder-hint focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all duration-200 min-h-[48px]"
                  placeholder="your@email.com"
                />
              </div>
            )}

            {error && (
              <div role="alert" className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            {!sent && (
              <button
                type="submit"
                disabled={loading || !onReset}
                className="w-full py-3.5 bg-accent hover:bg-accent/90 text-black font-semibold rounded-xl transition-all duration-200 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed min-h-[48px]"
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
            )}

            <button type="button" onClick={showSignIn} className="w-full py-3 text-sm text-muted hover:text-white min-h-[44px]">
              ← Back to sign in
            </button>
          </form>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-muted mb-2">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white placeholder-hint focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all duration-200 min-h-[48px]"
              placeholder="your@email.com"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="password" className="block text-sm font-medium text-muted">
                Password
              </label>
              {onReset && (
                <button type="button" onClick={showForgot} className="text-xs text-muted hover:text-accent min-h-[44px] px-1">
                  Forgot password?
                </button>
              )}
            </div>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white placeholder-hint focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all duration-200 min-h-[48px]"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 bg-accent hover:bg-accent/90 text-black font-semibold rounded-xl transition-all duration-200 hover:shadow-lg hover:shadow-accent/25 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed min-h-[48px]"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Signing in...
              </span>
            ) : (
              'Sign In'
            )}
          </button>
        </form>
        )}

        <p className="text-center text-xs text-muted-dim mt-8">
          Personal Life Operating System
        </p>
      </div>
    </div>
  )
}
