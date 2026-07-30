export default function Debts() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Debts 🤝</h1>
          <p className="text-muted text-sm mt-1">Track who owes whom</p>
        </div>
        <button
          disabled
          className="px-4 py-2.5 bg-accent/20 text-accent rounded-xl text-sm font-medium min-h-[48px] opacity-50 cursor-not-allowed"
        >
          + Add Debt
        </button>
      </div>

      {/* Direction Tabs */}
      <div className="flex gap-2">
        {['All', 'I Owe', 'Owe Me'].map((filter) => (
          <button
            key={filter}
            className={`px-4 py-2 rounded-xl text-sm font-medium min-h-[48px] transition-all duration-200 ${
              filter === 'All'
                ? 'bg-accent/15 text-accent'
                : 'bg-card text-muted hover:text-white border border-white/5'
            }`}
          >
            {filter}
          </button>
        ))}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-card rounded-2xl p-5 border border-white/5">
          <p className="text-sm text-muted mb-1">I Owe (Total)</p>
          <p className="text-2xl font-bold text-red-400">₦0.00</p>
        </div>
        <div className="bg-card rounded-2xl p-5 border border-white/5">
          <p className="text-sm text-muted mb-1">Owed To Me (Total)</p>
          <p className="text-2xl font-bold text-accent">₦0.00</p>
        </div>
      </div>

      {/* Debts List Placeholder */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <div className="flex flex-col items-center justify-center py-12 text-muted">
          <span className="text-5xl mb-4">🤝</span>
          <p className="text-lg font-medium text-white mb-1">No debts recorded</p>
          <p className="text-sm text-muted/60">Keep track of IOUs and settlements</p>
        </div>
      </section>
    </div>
  )
}
