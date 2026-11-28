import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { EXPORT_TABLES, toCsv, columnsFor, fetchAll, buildBundle, filenameFor } from '../../lib/export'
import Panel from '../ui/Panel'
import Button from '../ui/Button'
import { Select } from '../ui/Field'

/**
 * The way out. One table as a spreadsheet, or everything as one JSON file
 * -- the copy of your own numbers that lives somewhere other than a
 * database you do not run. Self-contained like the sections above it.
 *
 * No zip, so CSVs come one at a time: a zip needs a dependency this app has
 * gone without, and the JSON bundle is the "everything" case anyway.
 */

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next tick, not synchronously: Safari has been seen to
  // cancel a download whose URL vanished before the click landed.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const readTable = (table) =>
  fetchAll((from, to) =>
    supabase
      .from(table.name)
      .select('*')
      .order(table.order, { ascending: true })
      // Ties broken by id, or pages past the first thousand rows overlap.
      .order(table.name === 'jare_owner' ? 'user_id' : 'id', { ascending: true })
      .range(from, to),
  )

export default function ExportData() {
  const [table, setTable] = useState(EXPORT_TABLES[0].name)
  const [busy, setBusy] = useState(null)

  const exportCsv = async () => {
    const meta = EXPORT_TABLES.find((t) => t.name === table)
    setBusy('csv')
    try {
      const rows = await readTable(meta)
      download(filenameFor(meta.name, 'csv'), toCsv(rows, columnsFor(rows, meta.csvOmit || [])), 'text/csv;charset=utf-8')
      toast.success(`${rows.length} row${rows.length === 1 ? '' : 's'} exported`)
    } catch (err) {
      toast.error('Could not export: ' + (err?.message || 'check connection'))
    } finally {
      setBusy(null)
    }
  }

  const exportJson = async () => {
    setBusy('json')
    try {
      const bundle = await buildBundle(EXPORT_TABLES, readTable)
      download(filenameFor(null, 'json'), JSON.stringify(bundle, null, 2), 'application/json')
      const count = Object.values(bundle.tables).reduce((n, rows) => n + rows.length, 0)
      toast.success(
        `${count} row${count === 1 ? '' : 's'} across ${Object.keys(bundle.tables).length} tables` +
          (bundle.skipped.length ? ` (${bundle.skipped.length} skipped)` : ''),
      )
    } catch (err) {
      toast.error('Could not export: ' + (err?.message || 'check connection'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel id="export" label="Export" className="scroll-mt-16">
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 min-w-0">
            <Select id="export-table" label="One table as a spreadsheet" value={table} onChange={(e) => setTable(e.target.value)}>
              {EXPORT_TABLES.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" icon="export" onClick={exportCsv} disabled={busy !== null} loading={busy === 'csv'}>
            {busy === 'csv' ? 'Exporting…' : 'Download CSV'}
          </Button>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-border">
          <div className="min-w-0">
            <p className="text-heading text-foreground">Everything, as one file</p>
            <p className="text-body-sm text-muted mt-0.5">
              Every table you own, including bank email bodies and meal photos. The Gmail connection and your phones&apos;
              push subscriptions are never exported.
            </p>
          </div>
          <Button icon="export" onClick={exportJson} disabled={busy !== null} loading={busy === 'json'} className="shrink-0">
            {busy === 'json' ? 'Exporting…' : 'Download JSON'}
          </Button>
        </div>
      </div>
    </Panel>
  )
}
