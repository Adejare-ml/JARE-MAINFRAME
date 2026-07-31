import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import QuickLog from '../ui/QuickLog'
import ToastContainer from '../ui/ToastContainer'

export default function Layout({ children, onSignOut }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Sidebar onSignOut={onSignOut} />
      <BottomNav />
      
      {/* Main content area */}
      <main className="lg:ml-60 pb-24 lg:pb-8 px-4 md:px-6 lg:px-8 pt-6">
        <div className="max-w-5xl mx-auto">
          {children}
        </div>
      </main>

      <QuickLog />
      <ToastContainer />
    </div>
  )
}
