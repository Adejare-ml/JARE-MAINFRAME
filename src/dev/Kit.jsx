import { useState } from 'react'
import Icon, { GLYPH_NAMES } from '../components/ui/Icon'
import Panel from '../components/ui/Panel'
import PageHeader from '../components/ui/PageHeader'
import Readout from '../components/ui/Readout'
import Money from '../components/ui/Money'
import Stat from '../components/ui/Stat'
import ListRow, { ListRows } from '../components/ui/ListRow'
import Label from '../components/ui/Label'
import Button from '../components/ui/Button'
import IconButton from '../components/ui/IconButton'
import { Input, Select, Textarea } from '../components/ui/Field'
import Segmented from '../components/ui/Segmented'
import StatusDot from '../components/ui/StatusDot'
import Provenance from '../components/ui/Provenance'
import ProgressBar from '../components/ui/ProgressBar'
import ProgressRing from '../components/ui/ProgressRing'
import CategoryMark from '../components/ui/CategoryMark'
import Badge from '../components/ui/Badge'
import EmptyState from '../components/ui/EmptyState'
import ErrorState from '../components/ui/ErrorState'
import Skeleton from '../components/ui/Skeleton'
import { toast } from '../lib/toast'
import ToastContainer from '../components/ui/ToastContainer'
import Sheet from '../components/ui/Sheet'

/**
 * DEV-ONLY: every primitive in every state, at /__kit, no sign-in needed.
 * Imported by App.jsx behind import.meta.env.DEV, so it never ships.
 */
const STATUSES = ['ok', 'attention', 'failing', 'stale', 'never', 'offline', 'loading']

export default function Kit() {
  const [seg, setSeg] = useState('day')
  const [progress, setProgress] = useState(42)
  const [sheet, setSheet] = useState(false)
  const setTheme = (t, oled = false) => {
    document.documentElement.dataset.theme = t
    document.documentElement.dataset.oled = oled ? 'true' : 'false'
  }

  return (
    <div className="min-h-screen bg-background text-foreground px-4 py-6 max-w-3xl mx-auto space-y-3">
      <PageHeader
        title="Design kit"
        meta="DEV only · /__kit"
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setTheme('dark')}>Dark</Button>
            <Button size="sm" variant="secondary" onClick={() => setTheme('light')}>Light</Button>
            <Button size="sm" variant="secondary" onClick={() => setTheme('dark', true)}>OLED</Button>
          </>
        }
      />

      <Panel label="Readouts" meta="naira overflow rule">
        <div className="space-y-4">
          <Readout size="display" label="Safe to spend" value={84250.5} sub="After ₦20,000 still owed to goals." />
          <Readout size="display" label="12 to 14 characters" value={12345678.9} />
          <Readout size="display" label="15 or more characters" value={-123456789.4} tone="danger" />
          <Readout size="display" label="Compact" value={1234567890} />
          <div className="grid grid-cols-2 gap-3">
            <Readout label="Figure" value={56789.12} />
            <Readout label="Figure, long" value={1234567.89} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Readout label="Kcal left" kind="number" value={1100} unit="kcal" />
            <Readout label="Budget used" kind="percent" value={63.4} tone="warn" />
          </div>
        </div>
      </Panel>

      <Panel label="Money and stats">
        <div className="space-y-3">
          <p className="text-body">
            Expense <Money amount={-2500} /> · income <Money amount={35000} sign tone="positive" /> · whole <Money amount={1999.5} kobo={false} />
          </p>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Liquid" value={<Money amount={212860.75} kobo={false} />} />
            <Stat label="Savings" value={<Money amount={410000} kobo={false} />} />
            <Stat label="Invested" value={<Money amount={1250300} kobo={false} />} />
          </div>
        </div>
      </Panel>

      <Panel label="List rows" meta="3 rows" flush>
        <ListRows>
          <ListRow leading={<CategoryMark category="Transport" />} title="Bolt ride to Wuse" subtitle="Transport" meta={<Provenance source="opay" at="09:41:00" />} trailing={<Money amount={-2500} />} />
          <ListRow leading={<CategoryMark category="Transfer In" />} title="From Tunde, refund for tickets with a very long description that truncates" subtitle="Transfer In" meta={<Provenance source="manual" at="14:02:00" />} trailing={<Money amount={35000} sign tone="positive" />} onClick={() => toast.info('Row tapped')} />
          <ListRow leading={<StatusDot status="attention" />} title="1 transaction needs review" trailing={<Icon name="chevR" size={18} className="text-muted" />} to="/__kit" />
          <ListRow isNew title="A row inserted after mount" subtitle="Fades and moves 4px" />
        </ListRows>
      </Panel>

      <Panel label="Buttons">
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary" icon="plus">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon="trash">Delete</Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
          <Button size="sm" variant="secondary">Small secondary</Button>
          <IconButton name="settings" label="Settings" />
          <IconButton name="plus" label="Add" variant="secondary" />
          <IconButton name="check" label="Done" variant="primary" />
        </div>
      </Panel>

      <Panel label="Fields">
        <div className="space-y-3">
          <Input label="Amount" placeholder="0.00" hint="Kobo allowed." inputMode="decimal" />
          <Input label="Note" defaultValue="Taxi" error="Keep it under 60 characters." />
          <Select label="Wallet" defaultValue="gtb">
            <option value="gtb">GTBank</option>
            <option value="opay">OPay</option>
          </Select>
          <Textarea label="Plan" rows={2} placeholder="What matters today?" />
        </div>
      </Panel>

      <Panel label="Segmented, progress, status">
        <div className="space-y-4">
          <Segmented label="Range" options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} value={seg} onChange={setSeg} />
          <div className="space-y-2">
            <ProgressBar value={progress} label="Accent" />
            <ProgressBar value={88} tone="warn" label="Warn" />
            <ProgressBar value={100} tone="danger" label="Danger" />
            <Button size="sm" variant="secondary" onClick={() => setProgress((p) => (p + 23) % 100)}>Change value</Button>
          </div>
          <div className="flex items-center gap-4">
            <ProgressRing value={progress / 100} size={56} strokeWidth={5} />
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {STATUSES.map((s) => (
                <span key={s} className="flex items-center gap-2 type-data text-muted">
                  <StatusDot status={s} /> {s}
                </span>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge label="Default" />
            <Badge label="On track" tone="accent" />
            <Badge label="Watch it" tone="warn" />
            <Badge label="Over" tone="danger" />
          </div>
        </div>
      </Panel>

      <Panel label="Tones" tone="warn" meta="warn rule">
        <p className="text-body-sm text-muted">A panel that needs attention carries a 2px amber rule.</p>
      </Panel>
      <ErrorState message="The database did not answer." onRetry={() => {}} />

      <Panel label="Empty and loading">
        <EmptyState title="Nothing logged today" message="Tap a saved meal above, or add what you ate." actionLabel="Add food" onAction={() => {}} />
        <div className="space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-12" />
        </div>
      </Panel>

      <Panel label="Toast and sheet">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => toast.success('Logged ₦2,500.00 to Transport')}>Success toast</Button>
          <Button variant="secondary" onClick={() => toast.error('Failed to log: check connection')}>Error toast</Button>
          <Button variant="secondary" onClick={() => toast.info('Transaction voided', { action: { label: 'Undo', onClick: () => {} } })}>Info with action</Button>
          <Button variant="secondary" onClick={() => setSheet(true)}>Open sheet</Button>
        </div>
      </Panel>

      <Panel label="Type scale">
        <div className="space-y-2">
          <p className="text-display">Display 32</p>
          <p className="text-figure">Figure 22</p>
          <p className="text-title">Title 18</p>
          <p className="text-heading">Heading 15</p>
          <p className="text-body">Body 15, the default for row titles and copy.</p>
          <p className="text-body-sm text-muted">Body small 13, subtitles and helper text.</p>
          <Label as="p">Label 12 mono uppercase</Label>
          <p className="type-data text-muted-dim">Data 13 mono · 09:41 · GTBank alert</p>
        </div>
      </Panel>

      <Panel label="Glyphs" meta={`${GLYPH_NAMES.length} glyphs`}>
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
          {GLYPH_NAMES.map((name) => (
            <div key={name} className="flex flex-col items-center gap-1 py-2 rounded-control bg-surface-2">
              <Icon name={name} size={20} />
              <span className="type-data text-muted-dim text-xs">{name}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Sheet isOpen={sheet} onClose={() => setSheet(false)} title="Example sheet">
        <div className="px-4 pb-4 space-y-3">
          <p className="text-title">Example sheet</p>
          <p className="text-body-sm text-muted">Drag the handle down, tap the scrim, or press Escape.</p>
          <Button full onClick={() => setSheet(false)}>Close</Button>
        </div>
      </Sheet>
      <ToastContainer />
    </div>
  )
}
