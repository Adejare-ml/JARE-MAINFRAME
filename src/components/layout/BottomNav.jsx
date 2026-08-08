import { NavLink } from 'react-router-dom'
import { bottomNavItems } from '../../lib/nav'

const navItems = bottomNavItems()

export default function BottomNav() {
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-card/95 backdrop-blur-lg border-t border-white/5 z-40 safe-area-bottom">
      <div className="flex items-center justify-around px-1 py-1">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center py-2 px-2 rounded-xl min-w-[48px] min-h-[48px] transition-all duration-200 ${
                isActive
                  ? 'text-accent'
                  : 'text-muted hover:text-white'
              }`
            }
          >
            <span className="text-lg mb-0.5">{item.icon}</span>
            <span className="text-[10px] font-medium leading-tight">{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
