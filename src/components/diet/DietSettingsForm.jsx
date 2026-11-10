import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { validateSettings, splitToPercents, RANGES } from '../../lib/diet/settings'
import { SLOTS, SLOT_LABELS } from '../../lib/diet/totals'
import { maintenance, ageIn } from '../../lib/diet/target'

/**
 * Diet settings: the owner's measurements, targets, meal split and food
 * rules. One diet_settings row (migration 048), upserted on user_id.
 *
 * These are the details the build spec says to enter here rather than
 * hardcode: the repo is public, so nothing typed on this screen is ever in
 * the code. The coach and the food-vision prompts (Phases 2 to 4) read
 * the name, city, avoid list and substitutes from this row.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */
export default function DietSettingsForm({ settings, onSaved }) {
  const [form, setForm] = useState(() => toForm(settings))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))
  const setSplit = (slot) => (e) => setForm((f) => ({ ...f, split: { ...f.split, [slot]: e.target.value } }))
  const splitTotal = SLOTS.reduce((a, s) => a + (Number(form.split[s]) || 0), 0)

  const checked = validateSettings(form)
  const maint = checked.ok
    ? maintenance({
        weightKg: checked.value.weight_kg,
        heightCm: checked.value.height_cm,
        age: ageIn(checked.value.birth_year),
        sex: checked.value.sex,
        activityFactor: checked.value.activity_factor ?? 1.375,
      })
    : null

  const save = async (e) => {
    e.preventDefault()
    const r = validateSettings(form)
    if (!r.ok) {
      setErrors(r.errors)
      toast.error(Object.values(r.errors)[0])
      return
    }
    setErrors({})
    setSaving(true)
    const row = { ...r.value, activity_factor: r.value.activity_factor ?? 1.375, updated_at: new Date().toISOString() }
    const { error } = await supabase.from('diet_settings').upsert(row, { onConflict: 'user_id' })
    setSaving(false)
    if (error) {
      toast.error('Not saved: ' + error.message)
      return
    }
    toast.success('Diet settings saved ✓')
    onSaved?.()
  }

  const input = 'w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]'

  return (
    <form onSubmit={save} className="space-y-6" noValidate>
      <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider border-b border-white/5 pb-3">Targets</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field id="ds-kcal" label="Daily kcal" error={errors.kcal_target}>
            <input id="ds-kcal" type="number" inputMode="numeric" step="50" value={form.kcal_target} onChange={set('kcal_target')} placeholder="e.g. 2300" className={input} />
          </Field>
          <Field id="ds-protein" label="Protein, at least (g)" error={errors.protein_target_g}>
            <input id="ds-protein" type="number" inputMode="numeric" value={form.protein_target_g} onChange={set('protein_target_g')} placeholder="e.g. 100" className={input} />
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted">Meal split (% of the day)</legend>
          <div className="grid grid-cols-4 gap-2">
            {SLOTS.map((s) => (
              <label key={s} className="text-[11px] text-muted space-y-1">
                <span className="block">{SLOT_LABELS[s]}</span>
                <input type="number" inputMode="numeric" min="0" max="100" value={form.split[s]} onChange={setSplit(s)} className={`${input} px-2 text-center`} />
              </label>
            ))}
          </div>
          <p className={`text-[11px] ${splitTotal === 100 ? 'text-muted' : 'text-orange-300'}`} role={splitTotal === 100 ? undefined : 'alert'}>
            Adds up to {splitTotal}%{splitTotal === 100 ? '' : ' (needs 100%)'}
          </p>
        </fieldset>
      </section>

      <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider border-b border-white/5 pb-3">About you</h2>
        <p className="text-[11px] text-muted leading-relaxed">
          Used to work out maintenance (Mifflin-St Jeor) for the target review every 14 days. Stored only in your database, never in the app's code.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field id="ds-sex" label="Sex">
            <select id="ds-sex" value={form.sex} onChange={set('sex')} className={input}>
              <option value="">Not set</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </Field>
          <Field id="ds-by" label="Birth year" error={errors.birth_year}>
            <input id="ds-by" type="number" inputMode="numeric" value={form.birth_year} onChange={set('birth_year')} placeholder="YYYY" className={input} />
          </Field>
          <Field id="ds-h" label="Height (cm)" error={errors.height_cm}>
            <input id="ds-h" type="number" inputMode="decimal" value={form.height_cm} onChange={set('height_cm')} className={input} />
          </Field>
          <Field id="ds-w" label="Weight (kg)" error={errors.weight_kg}>
            <input id="ds-w" type="number" inputMode="decimal" step="0.1" value={form.weight_kg} onChange={set('weight_kg')} className={input} />
          </Field>
          <Field id="ds-af" label="Activity factor" error={errors.activity_factor}>
            <input id="ds-af" type="number" inputMode="decimal" step="0.025" min={RANGES.activity_factor[0]} max={RANGES.activity_factor[1]} value={form.activity_factor} onChange={set('activity_factor')} className={input} />
          </Field>
          <div className="text-[11px] text-muted self-end pb-3">{maint ? `Maintenance ≈ ${Math.round(maint).toLocaleString()} kcal` : 'Fill these in to see maintenance'}</div>
        </div>
        <p className="text-[11px] text-muted-dim">1.375 is light exercise 1 to 3 days a week. Exercise is never added back to the daily budget.</p>
      </section>

      <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider border-b border-white/5 pb-3">For the coach</h2>
        <p className="text-[11px] text-muted leading-relaxed">The coach and the photo reader (later phases) use these. Leave any of them blank.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field id="ds-name" label="Name">
            <input id="ds-name" value={form.display_name} onChange={set('display_name')} className={input} />
          </Field>
          <Field id="ds-city" label="City">
            <input id="ds-city" value={form.city} onChange={set('city')} className={input} />
          </Field>
        </div>
        <Field id="ds-avoid" label="Foods to avoid (comma-separated)">
          <input id="ds-avoid" value={form.avoid_foods} onChange={set('avoid_foods')} placeholder="e.g. onions" className={input} />
        </Field>
        <Field id="ds-subs" label="Use instead">
          <input id="ds-subs" value={form.substitutes} onChange={set('substitutes')} placeholder="e.g. cabbage and carrots" className={input} />
        </Field>
      </section>

      {/* Phase 3: the photo models and how long photos are kept. */}
      <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider border-b border-white/5 pb-3">Photo models</h2>
        <p className="text-[11px] text-muted leading-relaxed">
          Claude and NVIDIA read each photo in the cloud; Ollama reads it later on your laptop. Leave a model blank for the default. Photos older than the retention are
          deleted every week; blank keeps them.
        </p>
        <Field id="ds-nv" label="NVIDIA vision model (build.nvidia.com)" error={errors.nvidia_vision_model}>
          <input id="ds-nv" value={form.nvidia_vision_model} onChange={set('nvidia_vision_model')} placeholder="meta/llama-3.2-90b-vision-instruct" className={input} autoCapitalize="off" spellCheck="false" />
        </Field>
        <Field id="ds-ol" label="Ollama model on the laptop (fits in 8 GB)" error={errors.ollama_vision_model}>
          <input id="ds-ol" value={form.ollama_vision_model} onChange={set('ollama_vision_model')} placeholder="qwen3-vl:8b" className={input} autoCapitalize="off" spellCheck="false" />
        </Field>
        <Field id="ds-ret" label="Keep photos for (days)" error={errors.photo_retention_days}>
          <input id="ds-ret" type="number" inputMode="numeric" value={form.photo_retention_days} onChange={set('photo_retention_days')} placeholder="Keep them" className={input} />
        </Field>
      </section>

      <button type="submit" disabled={saving} className="w-full min-h-[52px] rounded-xl bg-accent text-black font-extrabold text-sm disabled:opacity-60">
        {saving ? 'Saving…' : 'Save diet settings'}
      </button>
    </form>
  )
}

function Field({ id, label, error, children }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs text-muted">
        {label}
      </label>
      {children}
      {error && (
        <p className="text-[11px] text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function toForm(s) {
  const v = (x) => (x == null ? '' : String(x))
  return {
    kcal_target: v(s?.kcal_target),
    protein_target_g: v(s?.protein_target_g),
    split: splitToPercents(s?.meal_split),
    sex: v(s?.sex),
    birth_year: v(s?.birth_year),
    height_cm: v(s?.height_cm),
    weight_kg: v(s?.weight_kg),
    activity_factor: v(s?.activity_factor ?? 1.375),
    display_name: v(s?.display_name),
    city: v(s?.city),
    avoid_foods: (s?.avoid_foods || []).join(', '),
    substitutes: v(s?.substitutes),
    photo_retention_days: v(s?.photo_retention_days),
    nvidia_vision_model: v(s?.nvidia_vision_model),
    ollama_vision_model: v(s?.ollama_vision_model),
  }
}
