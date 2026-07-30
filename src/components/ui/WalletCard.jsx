import { formatNaira } from '../../lib/formatters'

export default function WalletCard({ name, type, balance }) {
  const typeIcons = {
    bank: '🏦',
    mobile: '📱',
    cash: '💵',
  }

  return (
    <div className="bg-card rounded-2xl p-5 border border-white/5 hover:border-accent/30 transition-all duration-300">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">{typeIcons[type] || '💰'}</span>
          <span className="text-sm text-muted font-medium">{name}</span>
        </div>
        <span className="text-xs text-muted uppercase tracking-wider">{type}</span>
      </div>
      <p className="text-2xl font-bold text-white">
        {formatNaira(balance)}
      </p>
    </div>
  )
}
