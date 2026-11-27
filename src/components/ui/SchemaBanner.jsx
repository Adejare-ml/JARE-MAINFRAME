import StatusDot from './StatusDot'

/**
 * "Your database is behind the app."
 *
 * Shown when the schema probe found a column the app expects and the database
 * does not have. The app keeps working without it: this is the notice, not
 * the failure. It names the file, because the remedy is to open exactly that
 * file and paste it into the Supabase SQL editor.
 *
 * @param {{pending: string[]}} props - migration filenames still to run
 */
export default function SchemaBanner({ pending }) {
  if (!pending || pending.length === 0) return null

  return (
    <div role="status" className="bg-card border-b border-border border-l-2 border-l-warn px-4 py-2.5">
      <p className="text-body-sm text-muted max-w-3xl mx-auto">
        <StatusDot status="warn" className="mr-2 align-middle" />
        <span className="font-semibold text-foreground">Database is behind the app.</span> Some fields are hidden until you run{' '}
        {pending.map((file, i) => (
          <span key={file}>
            {i > 0 && ', '}
            <code className="type-data text-foreground break-all">supabase/migrations/{file}</code>
          </span>
        ))}{' '}
        in the Supabase SQL editor. Everything else works normally.
      </p>
    </div>
  )
}
