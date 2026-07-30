import WalletCard from '../components/ui/WalletCard'
import Badge from '../components/ui/Badge'

export default function Budget() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Budget 💰</h1>
          <p className="text-muted text-sm mt-1">Track your income, spending & wallets</p>
        </div>
        <button
          disabled
          className="px-4 py-2.5 bg-accent/20 text-accent rounded-xl text-sm font-medium min-h-[48px] opacity-50 cursor-not-allowed"
        >
          + Add Transaction
        </button>
      </div>

      {/* Wallets */}
      <section>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-3">Wallets</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <WalletCard name="GTBank" type="bank" balance={0} />
          <WalletCard name="OPay" type="mobile" balance={0} />
          <WalletCard name="Cash" type="cash" balance={0} />
        </div>
      </section>

      {/* Monthly Budget Placeholder */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-4">July 2026 Budget</h2>
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-muted text-sm">Expected Income</span>
            <span className="text-white font-medium">₦0.00</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted text-sm">Total Spent</span>
            <span className="text-red-400 font-medium">₦0.00</span>
          </div>
          <div className="h-2 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full w-0 transition-all duration-500" />
          </div>
        </div>
      </section>

      {/* Category Breakdown Placeholder */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-4">Categories</h2>
        <div className="flex flex-wrap gap-2">
          <Badge category="Feeding / Groceries" />
          <Badge category="Transport" />
          <Badge category="Airtime & Data" />
          <Badge category="Electricity" />
          <Badge category="Family Support" />
        </div>
      </section>

      {/* Transactions Placeholder */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-4">Recent Transactions</h2>
        <div className="flex flex-col items-center justify-center py-8 text-muted">
          <span className="text-4xl mb-3">💳</span>
          <p className="text-sm">No transactions yet</p>
          <p className="text-xs text-muted/60 mt-1">Add your first transaction to get started</p>
        </div>
      </section>
    </div>
  )
}
