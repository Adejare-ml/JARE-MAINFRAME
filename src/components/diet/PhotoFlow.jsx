import { useEffect, useRef, useState } from 'react'
import { prepareImage } from '../../lib/imagePrep'
import { MODEL_LABELS } from '../../lib/diet/merge'
import { sumNutrition, round1 } from '../../lib/diet/nutrition'
import { mealVerdict } from '../../lib/diet/verdict'
import { SLOT_LABELS, slotForHour, localHour } from '../../lib/diet/totals'
import { needsCoach } from '../../lib/diet/coach'
import { hasColumn } from '../../lib/schema'
import { toast } from '../../lib/toast'
import { confirmBuzz } from '../../lib/haptics'
import { supabase } from '../../lib/supabase'
import { uploadPhoto, analyzePhoto, acceptPhotoMeal, discardPhotoMeal, photoUrl, loadEstimates, coachMeal } from './api'
import VerdictBadge from './VerdictBadge'

/** 1024 px on the long side, as the build spec asks; JPEG at imagePrep's quality. */
const PHOTO_EDGE = 1024
/** Big enough that the 1024 px encoding is never stepped down for size. */
const PHOTO_MAX_CHARS = 1_400_000

/**
 * A photo, from the shutter to the logged reading.
 *
 *   1. prepareImage (src/lib/imagePrep.js) resizes to 1024 px and fixes bad
 *      light on the phone, and makes a 640 px copy for NVIDIA.
 *   2. The 1024 px photo goes to the private meal-photos bucket.
 *   3. diet-photo has Claude (Opus, high effort) and NVIDIA study it, merges
 *      them, logs the meal and seals it.
 *   4. The reading is shown as it was logged: each item with the amount, the
 *      calories and what the model saw that set the amount.
 *
 * The reading is final. The owner asked for this: "you have to be the point
 * of reason and honesty". Until 054 the result opened in ParsedReview with
 * steppers, a remove button per item and a Discard, so a photo could be
 * talked down to a smaller number. Now there is nothing to adjust, and the
 * database refuses an edit or a delete of a sealed photo meal even if a
 * screen tried (supabase/migrations/054_photo_meal_lock.sql).
 *
 * Opened two ways: with a fresh `file` from the camera, or with an existing
 * photo `meal` from the Today list. A meal the old flow left at 'auto' can
 * only be accepted as read.
 */
export default function PhotoFlow({ file = null, meal = null, lib, todayLogs = [], onDone, onCancel }) {
  const [stage, setStage] = useState(meal ? 'result' : 'preparing')
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(() => (meal ? fromMeal(meal) : null))
  const [models, setModels] = useState([])
  const [error, setError] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)
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
        setResult({ mealId: res.meal_id, sealed: res.sealed !== false, slot: slotForHour(localHour()), items: res.entry.items, note: (res.entry.questions || []).join(' ') || null, single: res.entry.single_model })
        setStage('result')
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
    if (stage === 'result' || stage === 'error' || stage === 'nofood') return
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started.current) / 1000)), 500)
    return () => clearInterval(t)
  }, [stage])

  const items = result?.items || []
  const totals = sumNutrition(items)
  const earlier = todayLogs.filter((l) => l.id !== result?.mealId)
  const verdict = mealVerdict({ settings: lib?.settings, slot: result?.slot, meal: totals, earlier })
  const unaccepted = meal?.status === 'auto'

  const finish = async () => {
    setBusy(true)
    try {
      let saved = { id: result.mealId, kcal: totals.kcal }
      if (unaccepted) saved = (await acceptPhotoMeal(result.mealId)) || saved
      // Verdict and reason change no calorie, so the owner's role may write them (054).
      if (!meal) await supabase.from('meal_logs').update({ verdict: verdict.verdict, reason: verdict.reason }).eq('id', result.mealId)
      if (needsCoach({ source: 'photo' }) && hasColumn('meal_logs.coach')) coachMeal(result.mealId)
      confirmBuzz()
      if (!meal || unaccepted) toast.success(`${Number(saved.kcal ?? totals.kcal).toLocaleString()} kcal logged`)
      onDone?.(saved)
    } catch (err) {
      toast.error('Not saved: ' + (err.message || 'check connection'))
    } finally {
      setBusy(false)
    }
  }

  const photo = preview && <img src={preview} alt="The meal" className="w-full max-h-56 object-cover rounded-2xl bg-black" />

  if (stage === 'result' && result) {
    return (
      <div className="space-y-4" aria-label="The reading">
        {photo}
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-muted uppercase tracking-wider">{SLOT_LABELS[result.slot] || 'Meal'}</p>
            <p className="text-3xl font-extrabold text-white tabular-nums leading-tight">
              {totals.kcal.toLocaleString()} <span className="text-base font-bold text-muted">kcal</span>
            </p>
            <p className="text-xs text-muted tabular-nums">
              {round1(totals.protein_g)} g protein · {round1(totals.carbs_g)} g carbs · {round1(totals.fat_g)} g fat
            </p>
          </div>
          <VerdictBadge verdict={verdict.verdict} />
        </div>

        <ul className="divide-y divide-white/5 rounded-2xl border border-white/10" aria-label="What the model saw">
          {items.map((it, i) => (
            <li key={i} className="px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-bold text-white min-w-0 truncate">
                  {it.name}
                  {it.hidden && <span className="text-[10px] text-muted font-normal"> (hidden)</span>}
                </p>
                <p className="text-sm font-bold text-white tabular-nums shrink-0">{Number(it.kcal).toLocaleString()}</p>
              </div>
              <p className="text-[11px] text-muted tabular-nums">
                {round1(it.grams)} g{basisOf(it) ? ` · ${basisOf(it)}` : ''}
              </p>
            </li>
          ))}
        </ul>

        {verdict.reason && <p className="text-[11px] text-muted leading-relaxed">{verdict.reason}</p>}
        {result.note && <p className="text-[11px] text-muted leading-relaxed">{result.note}</p>}

        {models.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 text-[10px]" aria-label="How each model did">
            {models.map((m) => (
              <li key={m.model_key} className={`px-2 py-1 rounded-full border ${m.status === 'ok' ? 'border-accent/30 text-accent' : 'border-white/10 text-muted'}`} title={m.reason || m.model_id}>
                {MODEL_LABELS[m.model_key]} {m.status === 'ok' ? `${(m.latency_ms / 1000).toFixed(1)} s` : m.status}
              </li>
            ))}
          </ul>
        )}

        <p className="text-[11px] text-muted-dim leading-relaxed">
          {unaccepted
            ? 'Logged before photo readings became final. Accept it as read; the amounts cannot be changed.'
            : 'Logged as read. A photo reading is final: it cannot be edited or deleted.'}
        </p>

        <button type="button" onClick={finish} disabled={busy} className="w-full min-h-[52px] rounded-xl bg-accent text-black font-extrabold text-sm disabled:opacity-50">
          {busy ? 'Saving…' : unaccepted ? 'Accept as read' : 'Done'}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3" aria-live="polite">
      {photo}
      {(stage === 'preparing' || stage === 'uploading' || stage === 'reading') && (
        <p className="text-sm text-white">
          {stage === 'preparing' ? 'Getting the photo ready…' : stage === 'uploading' ? 'Saving the photo…' : 'Studying the plate…'}{' '}
          <span className="text-muted tabular-nums">{elapsed} s</span>
        </p>
      )}
      {stage === 'nofood' && <p className="text-sm text-white">No food in that photo. Nothing was logged and the photo was deleted.</p>}
      {stage === 'error' && (
        <p className="text-sm text-orange-300" role="alert">
          Could not read the photo: {error}. Nothing was logged. Try another photo.
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

/** What the model said set the amount: the merged item keeps each model's raw answer. */
function basisOf(item) {
  const est = item.estimates || {}
  return est.claude?.basis || est.nvidia?.basis || est.ollama?.basis || item.basis || ''
}

/** A stored photo meal in the shape the result reads. */
function fromMeal(meal) {
  const items = [...(meal.meal_items || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  return { mealId: meal.id, sealed: meal.status !== 'auto', slot: meal.meal_slot, items, note: null, single: false }
}
