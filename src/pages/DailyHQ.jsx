import WalletCard from '../components/ui/WalletCard'

export default function DailyHQ() {
  const today = new Date()
  const greeting = today.getHours() < 12 ? 'Good Morning' : today.getHours() < 17 ? 'Good Afternoon' : 'Good Evening'
  const dateStr = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">{greeting}, Jare 👋</h1>
        <p className="text-muted text-sm mt-1">{dateStr}</p>
      </div>

      {/* Quick Wallets */}
      <section>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">Wallets</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <WalletCard name="GTBank" type="bank" balance={0} />
          <WalletCard name="OPay" type="mobile" balance={0} />
          <WalletCard name="Cash" type="cash" balance={0} />
        </div>
      </section>

      {/* Today's Summary Placeholder */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-4">Today's Overview</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center">
            <p className="text-2xl font-bold text-white">₦0</p>
            <p className="text-xs text-muted mt-1">Spent Today</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-white">0</p>
            <p className="text-xs text-muted mt-1">Transactions</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-accent">0</p>
            <p className="text-xs text-muted mt-1">Goals Active</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-white">0</p>
            <p className="text-xs text-muted mt-1">Open Debts</p>
          </div>
        </div>
      </section>

      {/* Recent Activity Placeholder */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-4">Recent Activity</h2>
        <div className="flex flex-col items-center justify-center py-8 text-muted">
          <span className="text-4xl mb-3">📋</span>
          <p className="text-sm">No recent activity yet</p>
          <p className="text-xs text-muted/60 mt-1">Transactions will appear here</p>
        </div>
      </section>
    </div>
  )
}
