import { formatNaira } from '../../lib/formatters'

export default function WalletCard({ name, type, balance, color }) {
  const typeIcons = {
    bank: '🏦',
    mobile: '📱',
    cash: '💵',
    savings: '🐖',
    investment: '📈',
  }

  const typeLabels = {
    bank: 'Bank',
    mobile: 'Mobile',
    cash: 'Cash',
    savings: 'Savings',
    investment: 'Investment',
  }

  const borderColor = color || '#22c55e'

  return (
    <div
      className="bg-card rounded-2xl p-5 border border-white/5 hover:border-opacity-60 transition-all duration-300"
      style={{ borderColor: `${borderColor}30`, '--wallet-accent': borderColor }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">{typeIcons[type] || '💰'}</span>
          <span className="text-sm text-muted font-medium">{name}</span>
        </div>
        <span
          className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
          style={{ backgroundColor: `${borderColor}15`, color: borderColor }}
        >
          {typeLabels[type] || type}
        </span>
      </div>
      <p className="text-2xl font-bold text-white">
        {formatNaira(balance)}
      </p>
    </div>
  )
}
