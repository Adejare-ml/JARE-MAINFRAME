/**
 * "Your database is behind the app."
 *
 * Shown when the schema probe found a column the app expects and the database
 * does not have. The app keeps working without it — this is the notice, not the
 * failure.
 *
 * It names the file rather than saying "a migration is pending", because the
 * remedy is to open exactly that file and paste it into the Supabase SQL
 * editor, and a message that makes you go and work out which one is a message
 * that gets ignored. This is the piece that was missing during the outage: the
 * app knew something was wrong for days and could only say
 * "column transactions.explanation does not exist".
 *
 * @param {{pending: string[]}} props - migration filenames still to run
 */
export default function SchemaBanner({ pending }) {
  if (!pending || pending.length === 0) return null

  return (
    <div
      role="status"
      className="bg-yellow-500/10 border-b border-yellow-500/30 px-4 py-2.5 text-center"
    >
      <p className="text-xs text-yellow-200/90 max-w-3xl mx-auto leading-relaxed">
        <span className="font-bold">Database is behind the app.</span>{' '}
        Some fields are hidden until you run{' '}
        {pending.map((file, i) => (
          <span key={file}>
            {i > 0 && ', '}
            <code className="font-mono text-yellow-100">supabase/migrations/{file}</code>
          </span>
        ))}{' '}
        in the Supabase SQL editor. Everything else works normally.
      </p>
    </div>
  )
}
