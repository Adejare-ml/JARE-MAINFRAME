import { useEffect, useRef, useState } from 'react'
import { prepareImage } from '../../lib/imagePrep'
import { MODEL_LABELS } from '../../lib/diet/merge'
import { uploadPhoto, analyzePhoto, confirmPhotoMeal, discardPhotoMeal, photoUrl, loadEstimates } from './api'
import ParsedReview from './ParsedReview'

/** 1024 px on the long side, as the build spec asks; JPEG at imagePrep's quality. */
const PHOTO_EDGE = 1024
/** Big enough that the 1024 px encoding is never stepped down for size. */
const PHOTO_MAX_CHARS = 1_400_000

/**
 * A photo, from the shutter to "Looks right" (Diet module, Phase 3).
 *
 *   1. prepareImage (src/lib/imagePrep.js) resizes to 1024 px and fixes bad
 *      light on the phone, and makes a 640 px copy for NVIDIA.
 *   2. The 1024 px photo goes to the private meal-photos bucket.
 *   3. diet-photo has Claude and NVIDIA read it at once, merges them and
 *      logs the meal as 'auto'. The laptop's Ollama is not waited for.
 *   4. The entry is shown pre-filled (ParsedReview): one tap on "Looks
 *      right", or the steppers first. Discard deletes the meal and the photo.
 *
 * Opened two ways: with a fresh `file` from the camera, or with an
 * existing 'auto' `meal` from the Today list ("Check"), in which case it
 * goes straight to step 4 with the stored items and photo.
 *
 * The elapsed seconds are shown while the models work, because the build
 * spec's bar is a photo logged in under 30 seconds and the owner should see
 * where the time goes.
 */
export default function PhotoFlow({ file = null, meal = null, lib, todayLogs = [], onDone, onCancel }) {
  const [stage, setStage] = useState(meal ? 'review' : 'preparing')
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(() => (meal ? fromMeal(meal) : null))
  const [models, setModels] = useState([])
  const [error, setError] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const path = useRef(meal?.photo_path ?? null)
  const started = useRef(0)

  // A fresh photo: prepare, upload, analyse.
  useEffect(() => {
    if (!file) return
    let cancelled = false
    started.current = Date.now()
    ;(async () => {
      try {
        const prepared = await prepareImage(file, { maxEdge: PHOTO_EDGE, maxChars: PHOTO_MAX_CHARS })
        if (cancelled) return
        setPreview(prepared.previewUrl)
        setStage('uploading')
        path.current = await uploadPhoto(prepared)
        if (cancelled) return
        setStage('reading')
        const res = await analyzePhoto({ path: path.current, small: prepared.small?.base64 })
        if (cancelled) return
        setModels(res.models || [])
        if (!res.ok) {
          await discardPhotoMeal({ photo_path: path.current }).catch(() => {})
          path.current = null
          setError(res.reason)
          setStage('error')
          return
        }
        if (res.no_food) {
          await discardPhotoMeal({ photo_path: path.current }).catch(() => {})
          path.current = null
          setStage('nofood')
          return
        }
        setResult({ mealId: res.meal_id, entry: toEntry(res.entry) })
        setStage('review')
      } catch (err) {
        if (cancelled) return
        if (path.current) await discardPhotoMeal({ photo_path: path.current }).catch(() => {})
        setError(err.message || 'something went wrong')
        setStage('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [file])

  // An existing meal: its photo and how each model did.
  useEffect(() => {
    if (!meal) return
    let url = null
    if (meal.photo_path) photoUrl(meal.photo_path).then((u) => setPreview((url = u)))
    loadEstimates(meal.id).then(setModels)
    return () => url && URL.revokeObjectURL(url)
  }, [meal])

  useEffect(() => {
    if (stage === 'review' || stage === 'error' || stage === 'nofood') return
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started.current) / 1000)), 500)
    return () => clearInterval(t)
  }, [stage])

  const discard = async () => {
    try {
      await discardPhotoMeal({ id: result?.mealId, photo_path: path.current })
    } finally {
      onCancel?.()
    }
  }

  const header = (
    <div className="space-y-2">
      {preview && <img src={preview} alt="The meal" className="w-full max-h-56 object-cover rounded-2xl bg-black" />}
      {models.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 text-[10px]" aria-label="How each model did">
          {models.map((m) => (
            <li key={m.model_key} className={`px-2 py-1 rounded-full border ${m.status === 'ok' ? 'border-accent/30 text-accent' : 'border-white/10 text-muted'}`} title={m.reason || m.model_id}>
              {MODEL_LABELS[m.model_key]} {m.status === 'ok' ? `✓ ${(m.latency_ms / 1000).toFixed(1)} s` : `✗ ${m.status}`}
            </li>
          ))}
          {!models.some((m) => m.model_key === 'ollama') && <li className="px-2 py-1 rounded-full border border-white/10 text-muted-dim">Ollama: later, from the laptop</li>}
        </ul>
      )}
      {result?.entry?.single_model && <p className="text-[11px] text-muted">Only one model read this photo, so nothing could be cross-checked.</p>}
    </div>
  )

  if (stage === 'review' && result) {
    return (
      <ParsedReview
        entry={result.entry}
        text={meal?.raw_text || ''}
        source="photo"
        lib={lib}
        todayLogs={todayLogs.filter((l) => l.id !== result.mealId)}
        header={header}
        backLabel="Discard"
        onBack={discard}
        onConfirm={(items, meta) =>
          confirmPhotoMeal(result.mealId, items, { status: meta.edited ? 'edited' : 'confirmed', meal_slot: meta.slot, verdict: meta.verdict, reason: meta.reason })
        }
        onDone={onDone}
      />
    )
  }

  return (
    <div className="space-y-3" aria-live="polite">
      {preview && <img src={preview} alt="The meal" className="w-full max-h-56 object-cover rounded-2xl bg-black" />}
      {(stage === 'preparing' || stage === 'uploading' || stage === 'reading') && (
        <p className="text-sm text-white">
          {stage === 'preparing' ? 'Getting the photo ready…' : stage === 'uploading' ? 'Saving the photo…' : 'Claude and NVIDIA are reading the plate…'}{' '}
          <span className="text-muted tabular-nums">{elapsed} s</span>
        </p>
      )}
      {stage === 'nofood' && <p className="text-sm text-white">No food in that photo. Nothing was logged and the photo was deleted.</p>}
      {stage === 'error' && (
        <p className="text-sm text-orange-300" role="alert">
          Could not read the photo: {error}. Nothing was logged; pick the food by hand instead.
        </p>
      )}
      {(stage === 'error' || stage === 'nofood') && (
        <button type="button" onClick={onCancel} className="w-full min-h-[48px] rounded-xl bg-white/5 border border-white/10 text-white text-sm font-bold">
          Back
        </button>
      )}
    </div>
  )
}

/** The merge result in the shape ParsedReview reads. */
function toEntry(merged) {
  return {
    ...merged,
    items: merged.items.map((it, i) => ({ ...it, key: it.key ?? `item-${i}` })),
    question: (merged.questions || []).join(' ') || null,
    pantry: [],
    meal_slot: null,
    saved_meal_id: null,
  }
}

/** A stored 'auto' meal back in the same shape, for "Check" from the Today list. */
function fromMeal(meal) {
  const items = [...(meal.meal_items || [])]
    .sort((a, b) => Number(b.flagged) - Number(a.flagged) || (a.position ?? 0) - (b.position ?? 0))
    .map((it, i) => ({ ...it, key: `item-${i}`, source: it.food_id ? 'food' : it.recipe_id ? 'recipe' : 'free' }))
  return {
    mealId: meal.id,
    entry: { items, question: null, pantry: [], meal_slot: meal.meal_slot, saved_meal_id: null, single_model: false },
  }
}
