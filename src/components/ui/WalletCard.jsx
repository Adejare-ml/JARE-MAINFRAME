import Panel from './Panel'
import Money from './Money'

const TYPE_LABELS = {
  bank: 'Bank',
  mobile: 'Mobile',
  cash: 'Cash',
  savings: 'Savings',
  investment: 'Investment',
}

/**
 * One wallet's balance. The wallet's stored colour is no longer painted on
 * the card: colour means state here, and a wallet is not a state.
 */
export default function WalletCard({ name, type, balance }) {
  return (
    <Panel label={name} meta={TYPE_LABELS[type] || type}>
      <Money amount={balance} className="text-figure" />
    </Panel>
  )
}
