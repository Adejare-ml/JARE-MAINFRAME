import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import QuickLog from '../ui/QuickLog'
import ToastContainer from '../ui/ToastContainer'
import SchemaBanner from '../ui/SchemaBanner'
import ZenModeToggle from '../ui/ZenModeToggle'
import StatusRail from '../ui/StatusRail'
import IconButton from '../ui/IconButton'
import { SystemStatusProvider } from '../../lib/useSystemStatus'

export default function Layout({ children, onSignOut, pendingMigrations = [] }) {
  return (
    <SystemStatusProvider>
      <div className="min-h-screen bg-background text-foreground">
        {/* Above everything, including the nav: it explains why fields are
            missing from every page below it. */}
        <SchemaBanner pending={pendingMigrations} />

        <Sidebar onSignOut={onSignOut} />

        {/* Mobile header, which is also the status rail: wordmark, system
            status, then zen and settings. 48px, solid, no blur. */}
        <header className="lg:hidden sticky top-0 z-30 h-12 flex items-center gap-1 pl-4 pr-1 bg-card border-b border-border">
          <span className="type-label text-foreground shrink-0 mr-1">Jare</span>
          <div className="flex-1 min-w-0 flex">
            <StatusRail />
          </div>
          <ZenModeToggle />
          <IconButton name="settings" label="Settings" to="/settings" />
        </header>

        <BottomNav />

        <main className="lg:ml-60 pb-40 lg:pb-8 px-4 lg:px-8 pt-4 lg:pt-6">
          <div className="max-w-5xl mx-auto">{children}</div>
        </main>

        <QuickLog />
        <ToastContainer />
      </div>
    </SystemStatusProvider>
  )
}
