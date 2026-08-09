import { Link } from 'react-router-dom'
import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import QuickLog from '../ui/QuickLog'
import ToastContainer from '../ui/ToastContainer'
import SchemaBanner from '../ui/SchemaBanner'

export default function Layout({ children, onSignOut, pendingMigrations = [] }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Above everything, including the nav: it explains why fields are
          missing from every page below it. */}
      <SchemaBanner pending={pendingMigrations} />

      {/* Desktop Sidebar */}
      <Sidebar onSignOut={onSignOut} />

      {/* Mobile Top Header with Gear Icon */}
      <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-white/5 bg-card/95 backdrop-blur-md sticky top-0 z-30">
        <h1 className="text-base font-bold text-white tracking-tight">
          <span className="text-accent">J</span>are
          <span className="text-muted ml-1 text-xs font-normal">Mainframe</span>
        </h1>
        <Link
          to="/settings"
          className="w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center text-lg transition-colors min-h-[48px] min-w-[48px]"
          aria-label="Settings"
        >
          ⚙️
        </Link>
      </div>

      {/* Bottom Nav on Mobile */}
      <BottomNav />
      
      {/* Main content area */}
      <main className="lg:ml-60 pb-24 lg:pb-8 px-4 md:px-6 lg:px-8 pt-4 lg:pt-6">
        <div className="max-w-5xl mx-auto">
          {children}
        </div>
      </main>

      <QuickLog />
      <ToastContainer />
    </div>
  )
}
