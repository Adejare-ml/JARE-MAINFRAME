import { useEffect, useRef, useState } from 'react'
import { parseSpokenTasks, isSpeechSupported, speechRecognizer } from '../../lib/speech'

/**
 * Say what the day holds, instead of typing it into three boxes.
 *
 * The typed field is the baseline and the microphone is an accelerator on top
 * of it -- not the other way round. Speech recognition is missing in Firefox,
 * in most iOS webviews, and behind a permission prompt everywhere else, so a
 * dictation-only surface would be a button that silently does nothing for a
 * large share of the time. That is this project's recurring failure shape, and
 * the arrangement here is what prevents it: with no `SpeechRecognition` at all,
 * this component still works completely, it just has one fewer button.
 *
 * Nothing is written until you have seen what it understood. Splitting speech
 * into tasks is a judgement call -- see src/lib/speech.js on why commas are not
 * separators -- and a judgement call that writes straight to your day is one you
 * would have to undo rather than correct.
 */
export default function DictateDay({ onAdd, busy, remaining }) {
  const [text, setText] = useState('')
  const [listening, setListening] = useState(false)
  const [micError, setMicError] = useState(null)
  const recognitionRef = useRef(null)

  const supported = isSpeechSupported()
  const tasks = parseSpokenTasks(text).slice(0, Math.max(0, remaining))
  const overflow = parseSpokenTasks(text).length - tasks.length

  // Stop the microphone if the component goes away mid-sentence. Without this
  // the browser keeps the recogniser -- and the recording indicator -- alive
  // after you have navigated somewhere else.
  useEffect(() => () => recognitionRef.current?.stop(), [])

  const listen = () => {
    const Recognition = speechRecognizer()
    if (!Recognition) return

    setMicError(null)
    const recognition = new Recognition()
    recognition.lang = 'en-NG'
    recognition.continuous = true
    recognition.interimResults = false

    recognition.onresult = (event) => {
      // Only the final results, appended. Interim results rewrite themselves as
      // the recogniser changes its mind, and appending those produces the same
      // phrase three times with different endings.
      let heard = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) heard += `${event.results[i][0].transcript} `
      }
      if (heard.trim()) setText((prev) => (prev ? `${prev.trim()} ${heard.trim()}` : heard.trim()))
    }

    // Errors are shown, not swallowed. "not-allowed" means the permission was
    // refused, and a mic button that appears to do nothing is exactly what this
    // component is arranged to avoid.
    recognition.onerror = (event) => {
      setListening(false)
      if (event.error === 'no-speech') return
      setMicError(
        event.error === 'not-allowed'
          ? 'Microphone permission was refused — type it instead.'
          : `Dictation stopped (${event.error}). Type it instead.`,
      )
    }
    recognition.onend = () => setListening(false)

    recognitionRef.current = recognition
    setListening(true)
    recognition.start()
  }

  const stop = () => {
    recognitionRef.current?.stop()
    setListening(false)
  }

  const commit = () => {
    if (tasks.length === 0) return
    onAdd(tasks)
    setText('')
  }

  if (remaining <= 0) return null

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="What matters today? Say or type it — one per line, or “and then”."
          aria-label="Today's plan"
          className="flex-1 px-4 py-3 bg-background border border-white/10 rounded-2xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent resize-none"
        />

        {/* Only where it can actually work. */}
        {supported && (
          <button
            type="button"
            onClick={listening ? stop : listen}
            aria-label={listening ? 'Stop dictating' : 'Dictate today’s plan'}
            aria-pressed={listening}
            className={`w-14 flex-shrink-0 rounded-2xl border text-xl transition-colors ${
              listening
                ? 'bg-red-500/20 border-red-500 text-red-300 animate-pulse'
                : 'bg-background border-white/10 text-muted hover:text-white hover:border-white/20'
            }`}
          >
            {listening ? '■' : '🎙'}
          </button>
        )}
      </div>

      {micError && <p className="text-[11px] text-yellow-400">{micError}</p>}

      {listening && (
        <p className="text-[11px] text-muted" role="status">
          Listening — say them however you like, then press stop.
        </p>
      )}

      {/* What it understood, before anything is written. */}
      {tasks.length > 0 && (
        <div className="bg-background/60 border border-white/10 rounded-2xl p-3 space-y-1.5">
          <p className="text-[10px] text-muted uppercase tracking-wider">
            {tasks.length} task{tasks.length === 1 ? '' : 's'}
          </p>
          <ul className="space-y-0.5">
            {tasks.map((task) => (
              <li key={task} className="text-sm text-white">
                • {task}
              </li>
            ))}
          </ul>
          {overflow > 0 && (
            <p className="text-[11px] text-yellow-400">
              {overflow} more won’t fit today — there is room for {remaining}.
            </p>
          )}
          <button
            type="button"
            onClick={commit}
            disabled={busy}
            className="w-full mt-1 py-2.5 bg-accent text-black font-bold text-xs rounded-xl min-h-[44px] disabled:opacity-50"
          >
            {busy ? 'Adding…' : `Add ${tasks.length === 1 ? 'it' : 'them'}`}
          </button>
        </div>
      )}
    </div>
  )
}
