import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { confirmBuzz } from '../../lib/haptics'
import { toDateOnly } from '../../lib/queries'
import { isMissingFunctionError } from '../../lib/corrections'
import { prepareImage, captureFrame, isSupportedImage } from '../../lib/imagePrep'
import { mealTypeFor, itemsForStorage, sumCalories, LIMITS, newItem } from '../../lib/meals'
import { isValidDate } from '../../lib/sync/normalize'
import Sheet from '../ui/Sheet'
import MealReview, { searchDishes } from './MealReview'

/**
 * From a plate to a logged meal.
 *
 * Four ways in, one way out. In: the camera (a file input with
 * capture=environment, which the OS answers with its camera app on a
 * phone), a picked, dropped or pasted file (the desktop's usual: the photo
 * is already on the machine, or on WhatsApp Web), the webcam (desktop,
 * feature-detected), or no photo at all -- a sentence the model reads, or
 * a dish picked from the same list the prompt is built on, which needs no
 * model and works when the function is not deployed, the key not set, or
 * both providers down. Out: the review step, where every dish is a row
 * with a quantity stepper, and one tap logs the sum.
 *
 * The photo is downscaled and, if the light is bad, corrected on the phone
 * (src/lib/imagePrep.js) before it leaves; a frame with nothing lit in it
 * is stopped here with a reason rather than sent for a twenty-second
 * "could not read". The upload goes to the analyze-meal edge function,
 * never to a model host directly (the CSP forbids it), and is never stored.
 *
 * Like QuickLog, an idempotency key is minted when the sheet opens, so a
 * retried "Log" after dropped data inserts nothing twice; the function
 * answers {inserted: false, reason: 'duplicate'} and the page treats it as
 * done.
 */

const STEPS = { CHOOSE: 'choose', WEBCAM: 'webcam', WORKING: 'working', TEXT: 'text', PICK: 'pick', REVIEW: 'review', PROBLEM: 'problem' }

/** Status lines keyed to how long the model has been thinking. */
function workingLine(seconds, phase) {
  if (phase === 'preparing') return 'Preparing the photo…'
  if (phase === 'uploading') return 'Uploading…'
  if (seconds < 4) return 'Reading the plate…'
  if (seconds < 12) return 'Naming the dishes… usually 5 to 15 seconds'
  if (seconds < 25) return 'Still working. The model is slow right now.'
  return 'Taking longer than usual. You can cancel and describe it instead.'
}

/**
 * Call the function and always come back with {ok, ...}: supabase-js
 * throws on a non-2xx and on a function that is not deployed at all, and
 * both of those are things to say in words.
 */
async function analyze(body, signal) {
  try {
    const { data, error } = await supabase.functions.invoke('analyze-meal', { body, signal })
    if (error) {
      let reason = error.message || 'the meal service did not answer'
      try {
        const detail = await error.context?.json?.()
        if (detail?.reason) reason = detail.reason
      } catch {
        /* no JSON body */
      }
      if (/Failed to send a request|Failed to fetch|NetworkError/i.test(reason)) {
        reason = navigator.onLine === false
          ? 'You are offline. The photo is kept; try again when you are back.'
          : 'The meal service is not reachable. If it has never worked, it needs deploying: supabase functions deploy analyze-meal.'
      }
      return { ok: false, reason }
    }
    return data && typeof data === 'object' ? data : { ok: false, reason: 'empty answer from the meal service' }
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, reason: 'cancelled', cancelled: true }
    return { ok: false, reason: err?.message || 'could not reach the meal service' }
  }
}

export default function MealCapture({ isOpen, onClose, onLogged, initialMode = 'photo', initialFile = null }) {
  const [step, setStep] = useState(STEPS.CHOOSE)
  const [clientId, setClientId] = useState(null)
  const [photo, setPhoto] = useState(null) // result of prepareImage
  const [phase, setPhase] = useState('preparing')
  const [seconds, setSeconds] = useState(0)
  const [problem, setProblem] = useState(null) // {title, detail, retake: bool, useAnyway: bool}
  const [items, setItems] = useState([])
  const [analysis, setAnalysis] = useState(null) // {provider, model, quality, advice}
  const [mealType, setMealType] = useState(() => mealTypeFor(new Date().getHours()))
  const [note, setNote] = useState('')
  const [hint, setHint] = useState('')
  const [text, setText] = useState('')
  const [pickQuery, setPickQuery] = useState('')
  const [eatenOn, setEatenOn] = useState(() => toDateOnly(new Date()))
  const [source, setSource] = useState('photo')
  const [logging, setLogging] = useState(false)
  const [justLogged, setJustLogged] = useState(false)
  const [dragging, setDragging] = useState(false)
  const abortRef = useRef(null)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const cameraInputRef = useRef(null)

  const today = toDateOnly(new Date())
  const webcamPossible = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)

  const stopWebcam = useCallback(() => {
    streamRef.current?.getTracks?.().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    stopWebcam()
    if (timerRef.current) clearInterval(timerRef.current)
    setStep(STEPS.CHOOSE)
    setPhoto(null)
    setProblem(null)
    setItems([])
    setAnalysis(null)
    setNote('')
    setHint('')
    setText('')
    setPickQuery('')
    setMealType(mealTypeFor(new Date().getHours()))
    setEatenOn(toDateOnly(new Date()))
    setSource('photo')
    setLogging(false)
    setJustLogged(false)
    setDragging(false)
  }, [stopWebcam])

  // A new key per opening, and the mode the opener asked for.
  useEffect(() => {
    if (!isOpen) {
      reset()
      return
    }
    setClientId(crypto.randomUUID())
    if (initialMode === 'text') setStep(STEPS.TEXT)
    else if (initialMode === 'pick') setStep(STEPS.PICK)
    else setStep(STEPS.CHOOSE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialMode])

  // The Daily HQ card hands a File straight over: its button IS the camera.
  useEffect(() => {
    if (isOpen && initialFile) handleFile(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialFile])

  // Leaving the component mid-analysis or mid-webcam must not leak either.
  useEffect(() => () => reset(), [reset])

  const beginTimer = () => {
    setSeconds(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
  }
  const endTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
  }

  const showProblem = (title, detail, options = {}) => {
    endTimer()
    setProblem({ title, detail, retake: options.retake !== false, useAnyway: Boolean(options.useAnyway) })
    setStep(STEPS.PROBLEM)
  }

  const goReview = (nextItems, meta = {}) => {
    endTimer()
    setItems(nextItems)
    setAnalysis(meta)
    if (meta.mealType) setMealType(meta.mealType)
    setStep(STEPS.REVIEW)
  }

  /** Send a prepared photo (or a sentence) to the model. */
  const runAnalysis = async ({ prepared = photo, description = '' } = {}) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setStep(STEPS.WORKING)
    setPhase('uploading')
    beginTimer()
    const now = new Date()
    const localTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const body = prepared
      ? {
          image: prepared.base64,
          imageSmall: prepared.small?.base64,
          mime: prepared.mime,
          hint: hint.trim().slice(0, LIMITS.hintChars),
          quality: { note: prepared.quality.note, corrected: prepared.quality.corrected },
          mealType,
          localTime,
        }
      : { text: description.trim().slice(0, LIMITS.textChars), mealType, localTime }
    setTimeout(() => setPhase('reading'), 1200)
    const result = await analyze(body, controller.signal)
    if (controller !== abortRef.current || result.cancelled) return
    if (!result.ok) {
      showProblem('Could not read it', result.reason || 'no answer from the model', { retake: Boolean(prepared) })
      return
    }
    const a = result.analysis || {}
    const found = Array.isArray(a.items) ? a.items.map((i) => newItem(i)) : []
    if (!a.is_food || found.length === 0) {
      showProblem(
        'No food in that',
        a.advice || 'Nothing on the plate could be named. Try closer, from above, with the light behind you.',
        { retake: Boolean(prepared) },
      )
      return
    }
    setSource(prepared ? 'photo' : 'text')
    goReview(found, {
      provider: result.provider,
      model: result.model,
      quality: { client: prepared?.quality || null, model: a.quality || null },
      advice: a.advice || null,
      mealType: a.meal_type || null,
    })
  }

  const handleFile = async (file) => {
    if (!file) return
    if (!isSupportedImage(file)) {
      showProblem('Not a photo', 'That file is not an image the browser can read. JPEG, PNG or WebP work.', { retake: true })
      return
    }
    stopWebcam()
    setStep(STEPS.WORKING)
    setPhase('preparing')
    beginTimer()
    let prepared
    try {
      prepared = await prepareImage(file)
    } catch (err) {
      showProblem('Could not open that photo', err?.message || 'Try a JPEG or PNG.', { retake: true })
      return
    }
    setPhoto(prepared)
    if (prepared.quality.unusable) {
      showProblem('Too dark to read', prepared.quality.note, { retake: true, useAnyway: true })
      return
    }
    await runAnalysis({ prepared })
  }

  const cancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
    endTimer()
    // Keep the prepared photo: a retry costs nothing.
    setStep(photo ? STEPS.PROBLEM : STEPS.CHOOSE)
    if (photo) setProblem({ title: 'Cancelled', detail: 'The photo is still here.', retake: true, useAnyway: false })
  }

  const startWebcam = async () => {
    setStep(STEPS.WEBCAM)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
    } catch (err) {
      showProblem(
        'Camera not available',
        err?.name === 'NotAllowedError'
          ? 'Camera permission was refused. Choose a photo instead.'
          : `The camera could not be opened (${err?.name || 'unknown'}). Choose a photo instead.`,
        { retake: false },
      )
    }
  }

  const snapWebcam = async () => {
    try {
      const blob = await captureFrame(videoRef.current)
      stopWebcam()
      await handleFile(new File([blob], 'webcam.jpg', { type: 'image/jpeg' }))
    } catch (err) {
      toast.error(err?.message || 'Could not take the picture')
    }
  }

  // Drop and paste, anywhere on the sheet while it waits for a photo.
  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer?.files?.[0]
    if (file) handleFile(file)
  }
  useEffect(() => {
    if (!isOpen || (step !== STEPS.CHOOSE && step !== STEPS.PROBLEM)) return undefined
    const onPaste = (e) => {
      const file = e.clipboardData?.files?.[0] || [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile()
      if (file) {
        e.preventDefault()
        handleFile(file)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, step])

  const pickMatches = searchDishes(pickQuery, 12)
  const pickDish = ([name, portion, kcal]) => {
    const next = [...items, newItem({ name, portion, calories: kcal, confidence: 'high', quantity: 1 })]
    setItems(next)
    setPickQuery('')
  }

  const log = async () => {
    const cleaned = itemsForStorage(items)
    if (cleaned.length === 0) {
      toast.error('Add at least one dish')
      return
    }
    if (!isValidDate(eatenOn) || eatenOn > today) {
      toast.error('Pick a date up to today')
      return
    }
    setLogging(true)
    const now = new Date()
    const eatenAt = eatenOn === today ? now.toTimeString().split(' ')[0] : null
    try {
      const { data, error } = await supabase.rpc('log_meal', {
        p_client_id: clientId,
        p_items: cleaned,
        p_eaten_on: eatenOn,
        p_eaten_at: eatenAt,
        p_meal_type: mealType,
        p_note: note.trim() || null,
        p_source: source,
        p_provider: analysis?.provider || null,
        p_model: analysis?.model || null,
        p_quality: analysis?.quality || null,
        p_thumbnail: photo?.thumbnail || null,
      })
      if (error) {
        if (isMissingFunctionError(error)) throw new Error('run supabase/migrations/042_meals.sql first')
        throw error
      }
      const kcal = data?.calories ?? sumCalories(cleaned)
      confirmBuzz()
      toast.success(`${Number(kcal).toLocaleString()} kcal logged ✓`)
      setJustLogged(true)
      onLogged?.(data)
      setTimeout(() => onClose(), 220)
    } catch (err) {
      console.error('Error logging meal:', err)
      toast.error('Not logged: ' + (err.message || 'check connection and retry'))
    } finally {
      setLogging(false)
    }
  }

  if (!isOpen) return null

  const title =
    step === STEPS.REVIEW ? 'Check the meal' : step === STEPS.TEXT ? 'Describe the meal' : step === STEPS.PICK ? 'Pick the dishes' : 'Log a meal'

  const bigButton = 'w-full flex items-center gap-3 p-4 rounded-2xl border text-left min-h-[56px] transition-all'

  const renderChoose = () => (
    <div
      className={`space-y-3 rounded-2xl ${dragging ? 'ring-2 ring-accent ring-offset-2 ring-offset-card' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <label className={`${bigButton} bg-accent text-black border-accent cursor-pointer hover:bg-accent/90`}>
        <span className="text-2xl" aria-hidden="true">📷</span>
        <span>
          <span className="block font-extrabold text-sm">Take a photo</span>
          <span className="block text-[11px] opacity-80">Opens the camera on a phone</span>
        </span>
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => {
            handleFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </label>

      <label className={`${bigButton} bg-white/5 border-white/5 text-white cursor-pointer hover:bg-white/10`}>
        <span className="text-2xl" aria-hidden="true">🖼️</span>
        <span>
          <span className="block font-bold text-sm">Choose a photo</span>
          <span className="block text-[11px] text-muted">Or drop one here, or paste it</span>
        </span>
        <input
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            handleFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </label>

      {webcamPossible && (
        <button type="button" onClick={startWebcam} className={`${bigButton} bg-white/5 border-white/5 text-white hover:bg-white/10`}>
          <span className="text-2xl" aria-hidden="true">🎥</span>
          <span>
            <span className="block font-bold text-sm">Use the webcam</span>
            <span className="block text-[11px] text-muted">Hold the plate up to it</span>
          </span>
        </button>
      )}

      <div className="grid grid-cols-2 gap-2 pt-1">
        <button type="button" onClick={() => setStep(STEPS.TEXT)} className="p-3 rounded-2xl bg-white/5 border border-white/5 text-white text-sm font-bold min-h-[48px] hover:bg-white/10">
          ✍️ Describe it
        </button>
        <button type="button" onClick={() => setStep(STEPS.PICK)} className="p-3 rounded-2xl bg-white/5 border border-white/5 text-white text-sm font-bold min-h-[48px] hover:bg-white/10">
          📋 Pick from list
        </button>
      </div>

      <div>
        <label htmlFor="meal-hint" className="block text-xs font-medium text-muted mb-1">
          A note for the model (optional)
        </label>
        <input
          id="meal-hint"
          type="text"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          maxLength={LIMITS.hintChars}
          placeholder="e.g. the soup is ogbono, two wraps"
          className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
        />
      </div>
    </div>
  )

  const renderWebcam = () => (
    <div className="space-y-3">
      {/* muted: no audio track is requested, and a silent video needs no captions. */}
      <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-2xl bg-black aspect-[4/3] object-cover" />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            stopWebcam()
            setStep(STEPS.CHOOSE)
          }}
          className="flex-1 bg-white/5 text-muted hover:text-white rounded-xl font-bold text-sm min-h-[48px]"
        >
          Back
        </button>
        <button type="button" onClick={snapWebcam} className="flex-[2] bg-accent text-black rounded-xl font-extrabold text-sm min-h-[48px]">
          📷 Take the picture
        </button>
      </div>
    </div>
  )

  const renderWorking = () => (
    <div className="space-y-4 text-center">
      {photo?.previewUrl ? (
        <img src={photo.previewUrl} alt="Your plate, as it will be sent" className="w-full max-h-64 object-contain rounded-2xl bg-black" />
      ) : (
        <div className="h-32 rounded-2xl bg-white/5 flex items-center justify-center text-4xl" aria-hidden="true">
          ✍️
        </div>
      )}
      {photo?.quality && (
        <p className={`text-[11px] ${photo.quality.corrected ? 'text-orange-300' : 'text-muted-dim'}`}>
          {photo.quality.note}
          {photo.bytes ? ` · ${Math.round(photo.bytes / 1024)} KB` : ''}
        </p>
      )}
      <div className="flex items-center justify-center gap-2 text-sm text-white" role="status" aria-live="polite">
        <span className="inline-block w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        {workingLine(seconds, phase)}
      </div>
      <button type="button" onClick={cancel} className="px-5 py-2.5 rounded-xl bg-white/5 text-muted hover:text-white text-sm font-bold min-h-[48px]">
        Cancel
      </button>
    </div>
  )

  const renderProblem = () => (
    <div className="space-y-4">
      {photo?.previewUrl && <img src={photo.previewUrl} alt="Your plate; the model could not read it" className="w-full max-h-48 object-contain rounded-2xl bg-black" />}
      <div className="rounded-2xl bg-orange-500/10 border border-orange-500/20 p-4">
        <p className="text-sm font-bold text-orange-200">{problem?.title}</p>
        <p className="text-xs text-orange-200/80 mt-1 leading-relaxed">{problem?.detail}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {problem?.retake && (
          <button type="button" onClick={() => { setPhoto(null); setStep(STEPS.CHOOSE) }} className="p-3 rounded-xl bg-accent text-black font-extrabold text-sm min-h-[48px]">
            📷 Try another photo
          </button>
        )}
        {problem?.useAnyway && photo && (
          <button type="button" onClick={() => runAnalysis({ prepared: photo })} className="p-3 rounded-xl bg-white/5 border border-white/10 text-white font-bold text-sm min-h-[48px]">
            Send it anyway
          </button>
        )}
        {!problem?.useAnyway && photo && problem?.retake && (
          <button type="button" onClick={() => runAnalysis({ prepared: photo })} className="p-3 rounded-xl bg-white/5 border border-white/10 text-white font-bold text-sm min-h-[48px]">
            Retry this photo
          </button>
        )}
        <button type="button" onClick={() => setStep(STEPS.TEXT)} className="p-3 rounded-xl bg-white/5 border border-white/10 text-white font-bold text-sm min-h-[48px]">
          ✍️ Describe it
        </button>
        <button type="button" onClick={() => setStep(STEPS.PICK)} className="p-3 rounded-xl bg-white/5 border border-white/10 text-white font-bold text-sm min-h-[48px]">
          📋 Pick from list
        </button>
      </div>
    </div>
  )

  const renderText = () => (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (text.trim()) runAnalysis({ prepared: null, description: text })
      }}
      className="space-y-3"
    >
      <label htmlFor="meal-text" className="block text-xs font-medium text-muted">
        What did you eat?
      </label>
      <textarea
        id="meal-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={LIMITS.textChars}
        rows={4}
        autoFocus
        placeholder="e.g. two wraps of eba with egusi, three pieces of beef, a bottle of malt"
        className="w-full p-4 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent resize-none"
      />
      <div className="flex gap-2">
        <button type="button" onClick={() => setStep(STEPS.CHOOSE)} className="flex-1 bg-white/5 text-muted hover:text-white rounded-xl font-bold text-sm min-h-[48px]">
          Back
        </button>
        <button type="submit" disabled={!text.trim()} className="flex-[2] bg-accent text-black rounded-xl font-extrabold text-sm min-h-[48px] disabled:opacity-50">
          Estimate calories →
        </button>
      </div>
    </form>
  )

  const renderPick = () => (
    <div className="space-y-3">
      <label htmlFor="meal-pick" className="block text-xs font-medium text-muted">
        Find a dish (no model needed)
      </label>
      <input
        id="meal-pick"
        type="search"
        value={pickQuery}
        onChange={(e) => setPickQuery(e.target.value)}
        autoFocus
        placeholder="jollof, eba, suya, Coke…"
        className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
      />
      {items.length > 0 && (
        <p className="text-[11px] text-muted">
          On the plate: {items.map((i) => i.name).join(', ')} · {sumCalories(items)} kcal
        </p>
      )}
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-[40vh] overflow-y-auto pr-1" aria-label="Dishes">
        {pickMatches.map((row) => (
          <li key={row[0]}>
            <button type="button" onClick={() => pickDish(row)} className="w-full text-left px-3 py-2.5 rounded-xl bg-white/5 hover:bg-accent/15 border border-white/5 min-h-[48px]">
              <span className="block text-sm font-semibold text-white">{row[0]}</span>
              <span className="block text-[11px] text-muted">
                {row[1]} · {row[2]} kcal
              </span>
            </button>
          </li>
        ))}
        {pickQuery.trim() && pickMatches.length === 0 && <li className="text-xs text-muted py-2">Nothing by that name. You can add it with a calorie figure on the next step.</li>}
      </ul>
      <div className="flex gap-2">
        <button type="button" onClick={() => setStep(STEPS.CHOOSE)} className="flex-1 bg-white/5 text-muted hover:text-white rounded-xl font-bold text-sm min-h-[48px]">
          Back
        </button>
        <button
          type="button"
          onClick={() => {
            setSource('manual')
            goReview(items, { provider: null, model: null, quality: null, advice: null })
          }}
          disabled={items.length === 0}
          className="flex-[2] bg-accent text-black rounded-xl font-extrabold text-sm min-h-[48px] disabled:opacity-50"
        >
          Next → {items.length > 0 ? `${sumCalories(items)} kcal` : ''}
        </button>
      </div>
    </div>
  )

  const renderReview = () => (
    <div className="space-y-5">
      {photo?.thumbnail && (
        <div className="flex items-center gap-3">
          <img src={photo.thumbnail} alt="" className="w-14 h-14 rounded-xl object-cover bg-black" />
          <p className="text-[11px] text-muted-dim">
            {analysis?.provider ? `Read by ${analysis.provider}${analysis.model ? ` (${analysis.model})` : ''}.` : ''} The photo itself is not stored.
          </p>
        </div>
      )}
      <MealReview
        items={items}
        onItemsChange={setItems}
        mealType={mealType}
        onMealTypeChange={setMealType}
        note={note}
        onNoteChange={setNote}
        eatenOn={eatenOn}
        today={today}
        onEatenOnChange={setEatenOn}
        advice={analysis?.advice}
        qualityNote={photo?.quality?.corrected ? photo.quality.note : ''}
      />
      <button
        type="button"
        onClick={log}
        disabled={logging || justLogged || items.length === 0}
        className="w-full bg-accent text-black rounded-xl font-extrabold text-base py-4 hover:bg-accent/90 transition-all shadow-lg shadow-accent/20 disabled:opacity-50 min-h-[48px] flex items-center justify-center gap-2"
      >
        {justLogged ? (
          <span className="inline-block text-xl animate-check-pop" aria-hidden="true">✓</span>
        ) : logging ? (
          <span className="inline-block w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
        ) : (
          `Log ${sumCalories(items).toLocaleString()} kcal ✓`
        )}
      </button>
    </div>
  )

  const body = {
    [STEPS.CHOOSE]: renderChoose,
    [STEPS.WEBCAM]: renderWebcam,
    [STEPS.WORKING]: renderWorking,
    [STEPS.PROBLEM]: renderProblem,
    [STEPS.TEXT]: renderText,
    [STEPS.PICK]: renderPick,
    [STEPS.REVIEW]: renderReview,
  }[step]

  return (
    <Sheet isOpen={isOpen} onClose={onClose} title={title} desktopCenter maxWidth="max-w-xl">
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-card">
        {step === STEPS.REVIEW || step === STEPS.TEXT || step === STEPS.PICK ? (
          <button
            type="button"
            onClick={() => setStep(STEPS.CHOOSE)}
            className="text-muted hover:text-white font-bold text-sm min-h-[48px] min-w-[48px] flex items-center"
          >
            ← Back
          </button>
        ) : (
          <div className="w-12" />
        )}
        <h2 className="text-sm font-bold text-white">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 text-muted hover:text-white flex items-center justify-center font-bold text-sm min-h-[48px] min-w-[48px]"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="p-6 flex-1 overflow-y-auto">{body()}</div>
    </Sheet>
  )
}
