export default function Repairs() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Repairs 🔧</h1>
          <p className="text-muted text-sm mt-1">Track repairs & maintenance needs</p>
        </div>
        <button
          disabled
          className="px-4 py-2.5 bg-accent/20 text-accent rounded-xl text-sm font-medium min-h-[48px] opacity-50 cursor-not-allowed"
        >
          + Add Repair
        </button>
      </div>

      {/* Priority Filters */}
      <div className="flex gap-2">
        {['All', 'Urgent', 'Soon', 'Someday'].map((filter) => (
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

      {/* Status Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-card rounded-2xl p-4 border border-white/5 text-center">
          <p className="text-2xl font-bold text-yellow-500">0</p>
          <p className="text-xs text-muted mt-1">Pending</p>
        </div>
        <div className="bg-card rounded-2xl p-4 border border-white/5 text-center">
          <p className="text-2xl font-bold text-blue-400">0</p>
          <p className="text-xs text-muted mt-1">In Progress</p>
        </div>
        <div className="bg-card rounded-2xl p-4 border border-white/5 text-center">
          <p className="text-2xl font-bold text-accent">0</p>
          <p className="text-xs text-muted mt-1">Done</p>
        </div>
      </div>

      {/* Repairs List Placeholder */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <div className="flex flex-col items-center justify-center py-12 text-muted">
          <span className="text-5xl mb-4">🔧</span>
          <p className="text-lg font-medium text-white mb-1">No repairs tracked</p>
          <p className="text-sm text-muted-dim">Add items that need fixing or maintenance</p>
        </div>
      </section>

      {/* Estimated Costs */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-4">Cost Estimate</h2>
        <div className="flex justify-between items-center">
          <span className="text-muted text-sm">Total Estimated</span>
          <span className="text-white font-bold text-xl">₦0.00</span>
        </div>
      </section>
    </div>
  )
}
