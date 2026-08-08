import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import ErrorBoundary from './components/ErrorBoundary'
import Layout from './components/layout/Layout'
import Login from './pages/Login'
import DailyHQ from './pages/DailyHQ'
import Budget from './pages/Budget'
import Transactions from './pages/Transactions'
import Settings from './pages/Settings'
import Goals from './pages/Goals'
import Projects from './pages/Projects'
import Debts from './pages/Debts'
import Repairs from './pages/Repairs'

function App() {
  const { session, loading, signIn, signOut } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-muted text-sm">Loading Mainframe...</p>
        </div>
      </div>
    )
  }

  if (!session) {
    return <Login onLogin={signIn} />
  }

  return (
    <Layout onSignOut={signOut}>
      <ErrorBoundary>
        <Routes>
        <Route path="/" element={<DailyHQ />} />
        <Route path="/budget" element={<Budget />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/goals" element={<Goals />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/debts" element={<Debts />} />
        <Route path="/repairs" element={<Repairs />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
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
