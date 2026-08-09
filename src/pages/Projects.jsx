export default function Projects() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Projects 🛠️</h1>
          <p className="text-muted text-sm mt-1">Monthly project tracker with milestones</p>
        </div>
        <button
          disabled
          className="px-4 py-2.5 bg-accent/20 text-accent rounded-xl text-sm font-medium min-h-[48px] opacity-50 cursor-not-allowed"
        >
          + New Project
        </button>
      </div>

      {/* Status Filters */}
      <div className="flex gap-2">
        {['All', 'Active', 'Complete', 'Carried Over'].map((filter) => (
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

      {/* Projects List Placeholder */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <div className="flex flex-col items-center justify-center py-12 text-muted">
          <span className="text-5xl mb-4">🛠️</span>
          <p className="text-lg font-medium text-white mb-1">No projects yet</p>
          <p className="text-sm text-muted-dim">Create your first project to start tracking</p>
        </div>
      </section>

      {/* Monthly Overview */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-4">July 2026</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center">
            <p className="text-2xl font-bold text-white">0</p>
            <p className="text-xs text-muted mt-1">Total</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-accent">0</p>
            <p className="text-xs text-muted mt-1">Active</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-400">0</p>
            <p className="text-xs text-muted mt-1">Coding</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-orange-400">0</p>
            <p className="text-xs text-muted mt-1">Hands-on</p>
          </div>
        </div>
      </section>
    </div>
  )
}
