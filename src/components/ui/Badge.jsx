import { getCategoryColor } from '../../lib/formatters'

export default function Badge({ label, category }) {
  const colorClass = category ? getCategoryColor(category) : 'bg-gray-500'
  
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium text-white ${colorClass}`}>
      {label || category}
    </span>
  )
}
