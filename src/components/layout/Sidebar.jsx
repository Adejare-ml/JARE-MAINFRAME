import { NavLink } from 'react-router-dom'
import { sidebarItems } from '../../lib/nav'
import ZenModeToggle from '../ui/ZenModeToggle'
import Icon from '../ui/Icon'
import { StatusJobList } from '../ui/StatusRail'

const navItems = sidebarItems()

export default function Sidebar({ onSignOut }) {
  return (
    <aside className="hidden lg:flex flex-col w-60 h-screen bg-card border-r border-border fixed left-0 top-0 z-40">
      <div className="h-14 px-4 border-b border-border flex items-center justify-between">
        <span className="type-label text-foreground">Jare Mainframe</span>
        <ZenModeToggle />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5" aria-label="Main">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 min-h-12 rounded-control text-body transition-colors duration-150 ${
                isActive
                  ? 'bg-surface-2 text-foreground font-semibold'
                  : 'text-muted hover:text-foreground hover:bg-surface-2'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon name={item.icon} size={20} className={isActive ? 'text-accent' : ''} />
                <span>{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* The system's own state: every job, its dot and when it last ran. */}
      <div className="border-t border-border p-2">
        <StatusJobList />
      </div>

      <div className="p-2 border-t border-border">
        <button
          type="button"
          onClick={onSignOut}
          className="flex items-center gap-3 px-3 min-h-12 rounded-control text-body text-muted hover:text-danger hover:bg-surface-2 transition-colors duration-150 w-full"
        >
          <Icon name="signout" size={20} />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  )
}
