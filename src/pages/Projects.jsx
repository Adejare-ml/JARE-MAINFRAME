import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatDate } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
import EmptyState from '../components/ui/EmptyState'
import Sheet from '../components/ui/Sheet'
import { ProjectsSkeleton } from '../components/ui/PageSkeleton'
import { confirmBuzz } from '../lib/haptics'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import { hasColumn } from '../lib/schema'
import { startOfMonth, toDateOnly } from '../lib/queries'
import {
  TYPES,
  monthKey,
  projectCounts,
  milestoneProgress,
  filterProjects,
  carryOverCandidates,
  carryOverPayload,
} from '../lib/projects'

/**
 * The monthly project tracker the README promised and the first commit
 * scaffolded -- real now, on the two tables 026 heals. Structured like
 * Debts.jsx: one fetch, tabs, a Sheet for create/edit, inline confirm
 * delete. Milestones are rows of their own (the hand-made schema already
 * had that right), edited inside the same sheet.
 */

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'complete', label: 'Complete' },
  { id: 'carried', label: 'Carried Over' },
]

const EMPTY_FORM = {
  name: '',
  type: 'coding',
  description: '',
  stack: '',
  done_criteria: '',
  milestones: [],
}

const newMilestone = () => ({ key: `new-${Math.random().toString(36).slice(2)}`, title: '', due_date: '', completed: false })

export default function Projects() {
  const available = hasColumn('projects.user_id') && hasColumn('milestones.user_id')
  const thisMonth = startOfMonth()

  const [projects, setProjects] = useState([])
  const [milestones, setMilestones] = useState([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState(null)
  const [tab, setTab] = useState('all')

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [formError, setFormError] = useState(null)
  const [shake, setShake] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [carrying, setCarrying] = useState(false)

  const fetchProjects = useCallback(async () => {
    if (!available) {
      setLoading(false)
      return
    }
    try {
      setPageError(null)
      const [projRes, msRes] = await Promise.all([
        supabase.from('projects').select('*').order('month', { ascending: false }).order('created_at', { ascending: false }),
        supabase.from('milestones').select('*').order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true }),
      ])
      if (projRes.error) throw projRes.error
      if (msRes.error) throw msRes.error
      setProjects(projRes.data || [])
      setMilestones(msRes.data || [])
    } catch (err) {
      console.error('Error loading projects:', err)
      setPageError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [available])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  useRealtimeRefresh(['projects', 'milestones'], fetchProjects, { channelPrefix: 'projects', enabled: available })

  const byProject = useMemo(() => {
    const map = new Map()
    for (const m of milestones) {
      if (!map.has(m.project_id)) map.set(m.project_id, [])
      map.get(m.project_id).push(m)
    }
    return map
  }, [milestones])

  const thisMonthProjects = useMemo(() => projects.filter((p) => p.month === thisMonth), [projects, thisMonth])
  const counts = useMemo(() => projectCounts(thisMonthProjects), [thisMonthProjects])
  const candidates = useMemo(() => carryOverCandidates(projects, thisMonth), [projects, thisMonth])
  const visible = filterProjects(projects, tab)

  const openAdd = () => {
    setEditing(null)
    setForm({ ...EMPTY_FORM, milestones: [] })
    setFormError(null)
    setShowModal(true)
  }

  const openEdit = (project) => {
    setEditing(project)
    setFormError(null)
    setForm({
      name: project.name || '',
      type: project.type || 'coding',
      description: project.description || '',
      stack: project.stack || '',
      done_criteria: project.done_criteria || '',
      milestones: (byProject.get(project.id) || []).map((m) => ({
        key: m.id,
        id: m.id,
        title: m.title,
        due_date: m.due_date || '',
        completed: Boolean(m.completed),
      })),
    })
    setShowModal(true)
  }

  const fail = (message) => {
    setFormError(message)
    setShake(true)
    setTimeout(() => setShake(false), 400)
  }

  const setMilestone = (key, patch) =>
    setForm((f) => ({ ...f, milestones: f.milestones.map((m) => (m.key === key ? { ...m, ...patch } : m)) }))

  const handleSave = async (e) => {
    e.preventDefault()
    const name = form.name.trim()
    if (!name) {
      fail('What is the project called?')
      return
    }
    const kept = form.milestones.map((m) => ({ ...m, title: m.title.trim() })).filter((m) => m.title)

    setFormError(null)
    setSaving(true)
    try {
      const payload = {
        name,
        type: form.type,
        description: form.description.trim() || null,
        stack: form.stack.trim() || null,
        done_criteria: form.done_criteria.trim() || null,
        updated_at: new Date().toISOString(),
      }

      let projectId = editing?.id
      if (editing) {
        const { error } = await supabase.from('projects').update(payload).eq('id', editing.id)
        if (error) throw error
      } else {
        const { data, error } = await supabase
          .from('projects')
          .insert({ ...payload, month: thisMonth, status: 'active' })
          .select('id')
          .single()
        if (error) throw error
        projectId = data.id
      }

      // Milestones: upsert what is in the form, delete what was removed.
      const existing = editing ? byProject.get(editing.id) || [] : []
      const keptIds = new Set(kept.filter((m) => m.id).map((m) => m.id))
      const removed = existing.filter((m) => !keptIds.has(m.id)).map((m) => m.id)
      if (removed.length > 0) {
        const { error } = await supabase.from('milestones').delete().in('id', removed)
        if (error) throw error
      }
      for (const m of kept) {
        const row = {
          project_id: projectId,
          title: m.title,
          due_date: m.due_date || null,
          completed: m.completed,
          completed_at: m.completed ? m.completed_at || new Date().toISOString() : null,
        }
        const { error } = m.id
          ? await supabase.from('milestones').update(row).eq('id', m.id)
          : await supabase.from('milestones').insert(row)
        if (error) throw error
      }

      confirmBuzz()
      toast.success(editing ? 'Updated ✓' : 'Added ✓')
      fetchProjects()
      setJustSaved(true)
      setTimeout(() => {
        setShowModal(false)
        setJustSaved(false)
      }, 220)
    } catch (err) {
      console.error('Error saving project:', err)
      toast.error('Failed to save: ' + (err.message || 'check connection'))
    } finally {
      setSaving(false)
    }
  }

  const setStatus = async (project, status) => {
    const { error } = await supabase
      .from('projects')
      .update({
        status,
        completed_at: status === 'complete' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', project.id)
    if (error) toast.error('Failed to update: ' + error.message)
    else {
      if (status === 'complete') confirmBuzz()
      toast.success(status === 'complete' ? 'Marked complete ✓' : 'Reopened')
      fetchProjects()
    }
  }

  const toggleMilestone = async (m) => {
    const completed = !m.completed
    const { error } = await supabase
      .from('milestones')
      .update({ completed, completed_at: completed ? new Date().toISOString() : null })
      .eq('id', m.id)
    if (error) toast.error('Failed to update: ' + error.message)
    else {
      if (completed) confirmBuzz()
      fetchProjects()
    }
  }

  const carryOver = async () => {
    setCarrying(true)
    try {
      for (const p of candidates) {
        const { error } = await supabase.from('projects').update(carryOverPayload(p, thisMonth)).eq('id', p.id)
        if (error) throw error
      }
      confirmBuzz()
      toast.success(`Carried ${candidates.length} project${candidates.length === 1 ? '' : 's'} into this month`)
      fetchProjects()
    } catch (err) {
      toast.error('Could not carry over: ' + (err.message || 'check connection'))
    } finally {
      setCarrying(false)
    }
  }

  const handleDelete = async (id) => {
    const { error } = await supabase.from('projects').delete().eq('id', id)
    if (error) toast.error('Failed to delete: ' + error.message)
    else {
      toast.success('Deleted')
      setConfirmDeleteId(null)
      fetchProjects()
    }
  }

  if (loading) return <ProjectsSkeleton />

  if (!available) {
    return (
      <div className="space-y-6 pb-6">
        <h1 className="text-2xl md:text-3xl font-bold text-white">Projects 🛠️</h1>
        <div className="rounded-2xl bg-orange-500/10 border border-orange-500/20 p-5 text-sm text-orange-300 leading-relaxed">
          Run <code className="font-mono">supabase/migrations/026_projects.sql</code> in the Supabase SQL editor to switch this
          page on.
        </div>
      </div>
    )
  }

  if (pageError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl md:text-3xl font-bold text-white">Projects 🛠️</h1>
        <ErrorState message={pageError} onRetry={fetchProjects} />
      </div>
    )
  }

  const monthLabel = new Date(thisMonth + 'T00:00:00').toLocaleDateString('en-NG', { month: 'long', year: 'numeric' })

  return (
    <div className="space-y-6 pb-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Projects 🛠️</h1>
          <p className="text-muted text-sm mt-0.5">Monthly project tracker with milestones</p>
        </div>
        <button
          onClick={openAdd}
          className="px-4 py-2.5 bg-accent text-black rounded-xl text-sm font-bold min-h-[48px] flex-shrink-0"
        >
          + New
        </button>
      </div>

      {candidates.length > 0 && (
        <div className="bg-accent/10 border border-accent/20 rounded-2xl p-4 flex items-center justify-between gap-3">
          <p className="text-sm text-white">
            {candidates.length} unfinished project{candidates.length === 1 ? '' : 's'} from{' '}
            {candidates.length === 1 ? 'last month' : 'earlier months'}
          </p>
          <button
            onClick={carryOver}
            disabled={carrying}
            className="px-4 py-2 bg-accent text-black rounded-xl text-xs font-bold min-h-[44px] flex-shrink-0 disabled:opacity-50"
          >
            {carrying ? 'Carrying…' : 'Carry over'}
          </button>
        </div>
      )}

      {/* This month */}
      <section className="bg-card rounded-2xl p-5 border border-white/5">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-4">{monthLabel}</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            ['Total', counts.total, 'text-white'],
            ['Active', counts.active, 'text-accent'],
            ['Coding', counts.coding, 'text-blue-400'],
            ['Hands-on', counts.handsOn, 'text-orange-400'],
          ].map(([label, value, color]) => (
            <div key={label} className="text-center">
              <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
              <p className="text-xs text-muted mt-1">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap min-h-[48px] transition-all ${
              tab === t.id ? 'bg-accent text-black' : 'bg-card text-muted hover:text-white border border-white/5'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <div className="bg-card rounded-3xl border border-white/5">
          <EmptyState
            icon="🛠️"
            title={tab === 'all' ? 'No projects yet' : 'Nothing in this tab'}
            message={
              tab === 'all'
                ? 'Name the thing you are building this month, break it into milestones, and tick them off as you go'
                : 'Try a different tab, or start a project'
            }
            actionLabel="+ New project"
            onAction={openAdd}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((project) => {
            const rows = byProject.get(project.id) || []
            const progress = milestoneProgress(rows)
            const typeMeta = TYPES.find((t) => t.value === project.type)
            const isComplete = project.status === 'complete'

            return (
              <div
                key={project.id}
                className={`bg-card rounded-2xl p-5 border transition-all ${
                  isComplete ? 'border-white/5 opacity-60' : 'border-white/10'
                }`}
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span aria-hidden="true">{typeMeta?.icon || '🛠️'}</span>
                      <h3 className="text-sm font-bold text-white truncate">{project.name}</h3>
                      {isComplete && (
                        <span className="text-[9px] bg-white/5 text-muted px-1.5 py-0.5 rounded-full uppercase font-bold">
                          Complete
                        </span>
                      )}
                      {project.carried_from && (
                        <span className="text-[9px] bg-orange-500/15 text-orange-300 px-1.5 py-0.5 rounded-full uppercase font-bold">
                          From {monthKey(project.carried_from)}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted mt-0.5">
                      {typeMeta?.label || 'Project'} · {monthKey(project.month)}
                      {project.stack && ` · ${project.stack}`}
                    </p>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => openEdit(project)}
                      aria-label={`Edit ${project.name}`}
                      className="w-11 h-11 flex items-center justify-center rounded-xl hover:bg-white/5 text-muted hover:text-white"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(project.id)}
                      aria-label={`Delete ${project.name}`}
                      className="w-11 h-11 flex items-center justify-center rounded-xl hover:bg-red-500/10 text-muted hover:text-red-400"
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                {project.description && <p className="text-xs text-muted mb-3">{project.description}</p>}

                {rows.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <p className="text-xs text-muted">
                        {progress.done} of {progress.total} milestone{progress.total === 1 ? '' : 's'}
                      </p>
                      <p className="text-xs text-muted tabular-nums">{Math.round(progress.share * 100)}%</p>
                    </div>
                    <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full bg-accent rounded-full" style={{ width: `${progress.share * 100}%` }} />
                    </div>
                    <ul className="space-y-1 pt-1">
                      {rows.map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            onClick={() => toggleMilestone(m)}
                            aria-pressed={m.completed}
                            className="w-full flex items-center gap-2.5 py-1.5 text-left min-h-[40px]"
                          >
                            <span
                              className={`w-5 h-5 shrink-0 rounded-md border-2 flex items-center justify-center text-[10px] font-black ${
                                m.completed ? 'bg-accent border-accent text-black' : 'border-white/20 text-transparent'
                              }`}
                              aria-hidden="true"
                            >
                              ✓
                            </span>
                            <span className={`text-sm flex-1 min-w-0 truncate ${m.completed ? 'text-muted line-through' : 'text-white'}`}>
                              {m.title}
                            </span>
                            {m.due_date && (
                              <span
                                className={`text-[11px] shrink-0 ${
                                  !m.completed && m.due_date < toDateOnly(new Date()) ? 'text-red-400' : 'text-muted'
                                }`}
                              >
                                {formatDate(m.due_date)}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {project.done_criteria && (
                  <p className="text-[11px] text-muted mt-3 pt-3 border-t border-white/5">
                    <span className="text-muted-dim">Done when:</span> {project.done_criteria}
                  </p>
                )}

                <button
                  onClick={() => setStatus(project, isComplete ? 'active' : 'complete')}
                  className="mt-3 w-full py-2.5 text-xs font-semibold rounded-xl bg-white/5 hover:bg-white/10 text-muted hover:text-white min-h-[44px] transition-colors"
                >
                  {isComplete ? 'Reopen' : 'Mark complete'}
                </button>

                {confirmDeleteId === project.id && (
                  <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                    <p className="text-xs text-red-400 mb-2">Delete this project and its milestones?</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleDelete(project.id)}
                        className="flex-1 py-2.5 bg-red-500 text-white text-xs font-bold rounded-lg min-h-[44px]"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="flex-1 py-2.5 bg-white/5 text-muted text-xs font-bold rounded-lg min-h-[44px]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add / Edit */}
      <Sheet isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Edit project' : 'New project'} desktopCenter>
        <form onSubmit={handleSave} className={`p-6 space-y-4 overflow-y-auto ${shake ? 'animate-shake' : ''}`}>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">{editing ? 'Edit' : 'New'}</h2>
            <button
              type="button"
              onClick={() => setShowModal(false)}
              aria-label="Close"
              className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 text-muted hover:text-white"
            >
              ✕
            </button>
          </div>

          {formError && (
            <p role="alert" className="text-xs text-red-400 font-medium">
              {formError}
            </p>
          )}

          <div>
            <label className="block text-xs text-muted font-semibold mb-2">Type</label>
            <div className="grid grid-cols-2 gap-2">
              {TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setForm({ ...form, type: t.value })}
                  className={`px-3 py-3 rounded-xl border text-xs font-semibold min-h-[48px] transition-all ${
                    form.type === t.value ? 'border-accent bg-accent/10 text-accent' : 'border-white/10 bg-background text-muted'
                  }`}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-muted font-semibold mb-1">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="What are you building?"
              required
              className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
            />
          </div>

          <div>
            <label className="block text-xs text-muted font-semibold mb-1">Description</label>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Optional"
              className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted font-semibold mb-1">{form.type === 'coding' ? 'Stack' : 'Materials'}</label>
              <input
                value={form.stack}
                onChange={(e) => setForm({ ...form, stack: e.target.value })}
                placeholder={form.type === 'coding' ? 'React, Supabase' : 'Optional'}
                className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
              />
            </div>
            <div>
              <label className="block text-xs text-muted font-semibold mb-1">Done when</label>
              <input
                value={form.done_criteria}
                onChange={(e) => setForm({ ...form, done_criteria: e.target.value })}
                placeholder="It ships"
                className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs text-muted font-semibold">Milestones</label>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, milestones: [...f.milestones, newMilestone()] }))}
                className="text-xs font-semibold text-accent min-h-[32px] px-2"
              >
                + Add
              </button>
            </div>
            {form.milestones.length === 0 ? (
              <p className="text-[11px] text-muted-dim">Break it into steps you can tick off.</p>
            ) : (
              <div className="space-y-2">
                {form.milestones.map((m) => (
                  <div key={m.key} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setMilestone(m.key, { completed: !m.completed })}
                      aria-pressed={m.completed}
                      aria-label={m.completed ? 'Mark not done' : 'Mark done'}
                      className={`w-6 h-6 shrink-0 rounded-md border-2 flex items-center justify-center text-[10px] font-black ${
                        m.completed ? 'bg-accent border-accent text-black' : 'border-white/20 text-transparent'
                      }`}
                    >
                      ✓
                    </button>
                    <input
                      value={m.title}
                      onChange={(e) => setMilestone(m.key, { title: e.target.value })}
                      placeholder="Milestone"
                      className="flex-1 min-w-0 px-3 py-2.5 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[44px]"
                    />
                    <input
                      type="date"
                      value={m.due_date}
                      onChange={(e) => setMilestone(m.key, { due_date: e.target.value })}
                      aria-label="Due date"
                      className="w-32 px-2 py-2.5 bg-background border border-white/10 rounded-xl text-white text-xs focus:outline-none focus:border-accent min-h-[44px]"
                    />
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, milestones: f.milestones.filter((x) => x.key !== m.key) }))}
                      aria-label="Remove milestone"
                      className="w-9 h-9 shrink-0 flex items-center justify-center rounded-lg text-muted hover:text-red-400 hover:bg-red-500/10"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={saving || justSaved}
            className="w-full py-3.5 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50 flex items-center justify-center"
          >
            {justSaved ? (
              <span className="inline-block text-lg animate-check-pop" aria-hidden="true">
                ✓
              </span>
            ) : saving ? (
              'Saving…'
            ) : editing ? (
              'Save changes'
            ) : (
              'Add'
            )}
          </button>
        </form>
      </Sheet>
    </div>
  )
}
