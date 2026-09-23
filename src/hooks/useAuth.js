import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { isRecoveryUrl, RECOVERY_PATH } from '../lib/auth'

/**
 * The session, and the three things a single-user app can do about it:
 * sign in, sign out, and get back in after a forgotten password.
 *
 * `recovering` is true from the moment the reset link lands until the new
 * password is saved. It starts from the URL (src/lib/auth.js isRecoveryUrl)
 * rather than waiting for the PASSWORD_RECOVERY event, so the reset page
 * is the first thing painted and the sign-in page never flashes first.
 */
export function useAuth() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [recovering, setRecovering] = useState(() =>
    typeof window !== 'undefined' ? isRecoveryUrl(window.location) : false,
  )

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setSession(session)
        if (event === 'PASSWORD_RECOVERY') setRecovering(true)
        if (event === 'SIGNED_OUT') setRecovering(false)
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  const signIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    return { error }
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    return { error }
  }

  /**
   * Email a reset link. The link returns to RECOVERY_PATH on this origin,
   * which must be on the project's redirect allow-list (README, "Forgot
   * your password?"). Supabase rate-limits this per address.
   */
  const resetPassword = async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${RECOVERY_PATH}`,
    })
    return { error }
  }

  /** Save a new password for the signed-in (recovery) session. */
  const updatePassword = async (password) => {
    const { error } = await supabase.auth.updateUser({ password })
    return { error }
  }

  /** The reset page is done. App's catch-all route then moves the URL,
   *  still carrying the link's code, back to /. */
  const finishRecovery = () => setRecovering(false)

  return { session, loading, recovering, signIn, signOut, resetPassword, updatePassword, finishRecovery }
}
