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
import Readout from '../ui/Readout'
import { SheetBox } from './parts'
import ListRow, { ListRows } from '../ui/ListRow'
import Button, { Spinner } from '../ui/Button'
import Icon from '../ui/Icon'
import StatusDot from '../ui/StatusDot'

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

  const photo = preview && <img src={preview} alt="The meal" className="w-full max-h-56 object-cover rounded-panel border border-border bg-surface-2" />

  if (stage === 'result' && result) {
    return (
      <div className="space-y-3" aria-label="The reading">
        {photo}
        <div className="flex items-end justify-between gap-3">
          <Readout
            kind="number"
            label={SLOT_LABELS[result.slot] || 'Meal'}
            value={totals.kcal}
            unit="kcal"
            sub={`${round1(totals.protein_g)} g protein · ${round1(totals.carbs_g)} g carbs · ${round1(totals.fat_g)} g fat`}
          />
          <span className="shrink-0 pb-1">
            <VerdictBadge verdict={verdict.verdict} />
          </span>
        </div>

        <SheetBox label="What the model saw" meta={`${items.length} item${items.length === 1 ? '' : 's'}`}>
          <ListRows as="ul">
            {items.map((it, i) => (
              <ListRow
                key={i}
                as="li"
                wrap
                title={
                  <>
                    {it.name}
                    {it.hidden && <span className="text-body-sm text-muted"> (hidden)</span>}
                  </>
                }
                subtitle={`${round1(it.grams)} g${basisOf(it) ? ` · ${basisOf(it)}` : ''}`}
                trailing={<span className="font-medium text-foreground tabular-nums whitespace-nowrap">{Number(it.kcal).toLocaleString()}</span>}
              />
            ))}
          </ListRows>
        </SheetBox>

        {verdict.reason && <p className="text-body-sm text-muted">{verdict.reason}</p>}
        {result.note && <p className="text-body-sm text-muted">{result.note}</p>}

        {models.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="How each model did">
            {models.map((m) => (
              <li key={m.model_key} className="inline-flex items-center gap-1.5 type-data text-muted" title={m.reason || m.model_id}>
                <StatusDot status={m.status === 'ok' ? 'ok' : 'muted'} />
                {MODEL_LABELS[m.model_key]} {m.status === 'ok' ? `${(m.latency_ms / 1000).toFixed(1)} s` : m.status}
              </li>
            ))}
          </ul>
        )}

        <p className="flex items-start gap-2 text-body-sm text-muted-dim">
          <Icon name="lock" size={16} className="shrink-0 mt-0.5" />
          <span>
            {unaccepted
              ? 'Logged before photo readings became final. Accept it as read; the amounts cannot be changed.'
              : 'Logged as read. A photo reading is final: it cannot be edited or deleted.'}
          </span>
        </p>

        <Button full onClick={finish} loading={busy}>
          {busy ? 'Saving…' : unaccepted ? 'Accept as read' : 'Done'}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3" aria-live="polite">
      {photo}
      {(stage === 'preparing' || stage === 'uploading' || stage === 'reading') && (
        <p className="flex items-center gap-2 text-body text-foreground">
          <Spinner size={16} />
          <span>{stage === 'preparing' ? 'Getting the photo ready…' : stage === 'uploading' ? 'Saving the photo…' : 'Studying the plate…'}</span>
          <span className="type-data text-muted-dim tabular-nums">{elapsed} s</span>
        </p>
      )}
      {stage === 'nofood' && <p className="text-body text-foreground">No food in that photo. Nothing was logged and the photo was deleted.</p>}
      {stage === 'error' && (
        <p className="text-body-sm text-warn" role="alert">
          Could not read the photo: {error}. Nothing was logged. Try another photo.
        </p>
      )}
      {(stage === 'error' || stage === 'nofood') && (
        <Button variant="secondary" full onClick={onCancel}>
          Back
        </Button>
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
