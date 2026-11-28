import { NavLink } from 'react-router-dom'
import { bottomNavItems } from '../../lib/nav'
import Icon from '../ui/Icon'

const navItems = bottomNavItems()

export default function BottomNav() {
  return (
    <nav aria-label="Main" className="lg:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border z-40 safe-area-bottom">
      <div className="flex items-stretch justify-around">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `relative flex-1 flex flex-col items-center justify-center gap-0.5 min-h-14 transition-colors duration-150 ${
                // A rule as well as the colour: state is never colour alone.
                isActive
                  ? "text-accent before:absolute before:top-0 before:inset-x-3 before:h-0.5 before:bg-accent before:content-['']"
                  : 'text-muted hover:text-foreground'
              }`
            }
          >
            <Icon name={item.icon} size={22} />
            <span className="text-xs font-medium leading-4">{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
