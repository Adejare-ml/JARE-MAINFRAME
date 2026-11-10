import { useEffect, useRef, useState } from 'react'
import { isSpeechSupported, speechRecognizer, SPEECH_LANGS, fallbackSpeechLang } from '../../lib/speech'
import { PARSE_LIMITS } from '../../lib/diet/parse'
import { parseNote } from './api'

/**
 * Type it or say it: the note goes to the diet-parse edge function and the
 * entry it reads comes back to the parent for review (ParsedReview).
 *
 * The mic uses the Web Speech API, Nigerian English first and US English
 * when the browser does not have it (fallbackSpeechLang in speech.js). The
 * transcript lands in the text box, where it can be corrected before it is
 * sent: speech-to-text mishears food names, and a wrong word costs a
 * correction, not a wrong entry. Like DictateDay, the mic button is only
 * shown where recognition exists (no Firefox, many in-app browsers).
 *
 * Added for the Diet module, Phase 2 (docs/diet-module.md).
 */
export default function DescribeFood({ onParsed }) {
  const [text, setText] = useState('')
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [spoken, setSpoken] = useState(false)
  const recognitionRef = useRef(null)
  const canSpeak = isSpeechSupported()

  // Stop the recogniser (and the recording indicator) when the sheet closes.
  useEffect(() => () => recognitionRef.current?.stop(), [])

  const listen = (lang = SPEECH_LANGS[0]) => {
    const Recognition = speechRecognizer()
    if (!Recognition) return
    setError(null)
    const r = new Recognition()
    r.lang = lang
    r.continuous = false
    r.interimResults = true
    r.onresult = (event) => {
      let final = ''
      let partial = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript
        if (event.results[i].isFinal) final += `${t} `
        else partial += t
      }
      setInterim(partial)
      if (final.trim()) {
        setText((prev) => `${prev.trim()} ${final.trim()}`.trim().slice(0, PARSE_LIMITS.textChars))
        setSpoken(true)
      }
    }
    r.onerror = (event) => {
      const next = fallbackSpeechLang(lang, event.error)
      if (next) {
        recognitionRef.current = null
        listen(next)
        return
      }
      setListening(false)
      if (event.error === 'no-speech' || event.error === 'aborted') return
      setError(event.error === 'not-allowed' ? 'Microphone permission was refused. Type it instead.' : `Dictation stopped (${event.error}). Type it instead.`)
    }
    r.onend = () => {
      if (recognitionRef.current === r) {
        setListening(false)
        setInterim('')
      }
    }
    recognitionRef.current = r
    setListening(true)
    r.start()
  }

  const stop = () => {
    recognitionRef.current?.stop()
    setListening(false)
  }

  const send = async (e) => {
    e?.preventDefault()
    const note = text.trim()
    if (!note || busy) return
    stop()
    setBusy(true)
    setError(null)
    const res = await parseNote(note)
    setBusy(false)
    if (!res.ok) {
      setError(`${res.reason}. You can still pick foods below.`)
      return
    }
    onParsed({ entry: res.entry, text: note, source: spoken ? 'voice' : 'text' })
  }

  return (
    <form onSubmit={send} className="space-y-2" aria-label="Describe what you ate">
      <label htmlFor="diet-describe" className="block text-xs text-muted">
        Type or say it: "2 boiled eggs and a plantain", "bought 2 kg beans for 3,000"
      </label>
      <div className="flex gap-2 items-start">
        <textarea
          id="diet-describe"
          value={listening && interim ? `${text} ${interim}`.trim() : text}
          onChange={(e) => {
            setText(e.target.value.slice(0, PARSE_LIMITS.textChars))
            if (!e.target.value) setSpoken(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) send(e)
          }}
          rows={2}
          placeholder="What did you eat?"
          className="flex-1 min-w-0 px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px] resize-none"
        />
        {canSpeak && (
          <button
            type="button"
            onClick={() => (listening ? stop() : listen())}
            className={`shrink-0 w-12 h-12 rounded-xl border text-lg ${listening ? 'border-red-400 bg-red-400/15 animate-pulse' : 'border-white/10 bg-white/5'}`}
            aria-label={listening ? 'Stop listening' : 'Say it'}
            aria-pressed={listening}
          >
            {listening ? '■' : '🎙️'}
          </button>
        )}
      </div>
      {error && (
        <p className="text-[11px] text-orange-300" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={!text.trim() || busy} className="w-full min-h-[48px] rounded-xl bg-white/10 border border-white/10 text-white text-sm font-bold disabled:opacity-40">
        {busy ? 'Reading it…' : 'Fill it in for me'}
      </button>
    </form>
  )
}
