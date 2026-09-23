import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import { useSchemaCheck } from './hooks/useSchemaCheck'
import { useCustomCategories } from './hooks/useCustomCategories'
import ErrorBoundary from './components/ErrorBoundary'
import Layout from './components/layout/Layout'
import PageSkeleton from './components/ui/PageSkeleton'
// Login is the only page a logged-out visitor can reach, so it is the only one
// worth having in the first chunk. Everything else was statically imported,
// which meant typing an email address cost you the 800-line Settings page and
// the whole Debts module first.
import Login from './pages/Login'
import ResetPassword from './pages/ResetPassword'

const DailyHQ = lazy(() => import('./pages/DailyHQ'))
const Budget = lazy(() => import('./pages/Budget'))
const Transactions = lazy(() => import('./pages/Transactions'))
const Settings = lazy(() => import('./pages/Settings'))
const Goals = lazy(() => import('./pages/Goals'))
const Projects = lazy(() => import('./pages/Projects'))
const Debts = lazy(() => import('./pages/Debts'))
const Repairs = lazy(() => import('./pages/Repairs'))
const Ask = lazy(() => import('./pages/Ask'))

function App() {
  const { session, loading, recovering, signIn, signOut, resetPassword, updatePassword, finishRecovery } = useAuth()
  // Runs alongside the session restore, so the two waits overlap and no page
  // can query before we know which columns exist.
  const { checking, pending } = useSchemaCheck()
  // The user's own category names, loaded once the probe has said whether
  // the table exists and a session says whose rows to ask for.
  useCustomCategories(session?.user?.id, !checking)

  if (loading || checking) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-muted text-sm">Loading Mainframe...</p>
        </div>
      </div>
    )
  }

  // The reset link lands here signed in with a recovery session; the reset
  // page is the only thing shown until the new password is saved.
  if (recovering) {
    return (
      <ResetPassword
        onUpdate={updatePassword}
        onDone={finishRecovery}
        // Sign out first so a recovery session never lingers behind the
        // sign-in page; then leave recovery whether or not there was one.
        onCancel={async () => {
          await signOut()
          finishRecovery()
        }}
        // Loading is over by here, so no session means the link's code
        // could not be exchanged: used already, or expired.
        expired={!session}
      />
    )
  }

  if (!session) {
    return <Login onLogin={signIn} onReset={resetPassword} />
  }

  return (
    <Layout onSignOut={signOut} pendingMigrations={pending}>
      <ErrorBoundary>
        {/* Inside the boundary, so a chunk that fails to download on a bad
            connection surfaces as the app's error state rather than a blank
            screen. */}
        <Suspense fallback={<PageSkeleton />}>
        <Routes>
        <Route path="/" element={<DailyHQ />} />
        <Route path="/budget" element={<Budget />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/goals" element={<Goals />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/debts" element={<Debts />} />
        <Route path="/repairs" element={<Repairs />} />
        <Route path="/ask" element={<Ask />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  )
}

export default function AppWrapper() {
  return (
    <BrowserRouter>
      <App />
    </BrowserRouter>
  )
}
