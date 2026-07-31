import { NavLink } from 'react-router-dom'

const navItems = [
  { path: '/', label: 'Daily HQ', icon: '🏠' },
  { path: '/budget', label: 'Budget', icon: '💰' },
  { path: '/goals', label: 'Goals', icon: '🎯' },
  { path: '/projects', label: 'Projects', icon: '🛠️' },
  { path: '/debts', label: 'Debts', icon: '🤝' },
  { path: '/repairs', label: 'Repairs', icon: '🔧' },
  { path: '/settings', label: 'Settings', icon: '⚙️' },
]

export default function Sidebar({ onSignOut }) {
  return (
    <aside className="hidden lg:flex flex-col w-60 h-screen bg-card border-r border-white/5 fixed left-0 top-0 z-40">
      {/* Logo / Brand */}
      <div className="p-6 border-b border-white/5">
        <h1 className="text-xl font-bold text-white tracking-tight">
          <span className="text-accent">J</span>are
          <span className="text-muted ml-1 text-sm font-normal">Mainframe</span>
        </h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 min-h-[48px] ${
                isActive
                  ? 'bg-accent/15 text-accent'
                  : 'text-muted hover:text-white hover:bg-white/5'
              }`
            }
          >
            <span className="text-lg">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Sign Out */}
      <div className="p-3 border-t border-white/5">
        <button
          onClick={onSignOut}
          className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-muted hover:text-red-400 hover:bg-red-400/10 transition-all duration-200 w-full min-h-[48px]"
        >
          <span className="text-lg">🚪</span>
          <span>Sign Out</span>
        </button>
      </div>
    </aside>
  )
}
