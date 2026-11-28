import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatDate } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
import EmptyState from '../components/ui/EmptyState'
import Sheet from '../components/ui/Sheet'
import { ProjectsSkeleton } from '../components/ui/PageSkeleton'
import PageHeader from '../components/ui/PageHeader'
import Panel from '../components/ui/Panel'
import Stat from '../components/ui/Stat'
import ListRow, { ListRows } from '../components/ui/ListRow'
import Button from '../components/ui/Button'
import IconButton from '../components/ui/IconButton'
import Badge from '../components/ui/Badge'
import Segmented from '../components/ui/Segmented'
import StatusDot from '../components/ui/StatusDot'
import ProgressBar from '../components/ui/ProgressBar'
import Label from '../components/ui/Label'
import Icon from '../components/ui/Icon'
import { Field, Input, controlClasses } from '../components/ui/Field'
import TaskCheck from '../components/daily/TaskCheck'
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
  { id: 'carried', label: 'Carried' },
]

const EMPTY_FORM = {
  name: '',
  type: 'coding',
  description: '',
  stack: '',
  done_criteria: '',
  milestones: [],
}

const newMilestone = () => ({ key: `new-${crypto.randomUUID()}`, title: '', due_date: '', completed: false })

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
      toast.success(editing ? 'Updated' : 'Added')
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
      toast.success(status === 'complete' ? 'Marked complete' : 'Reopened')
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
      <div className="space-y-3 pb-6">
        <PageHeader title="Projects" />
        <Panel label="Setup needed" tone="warn">
          <p className="flex items-start gap-2 text-body-sm text-foreground">
            <StatusDot status="warn" className="mt-1.5" />
            <span>
              Run <code className="type-data">supabase/migrations/026_projects.sql</code> in the Supabase SQL editor to switch
              this page on.
            </span>
          </p>
        </Panel>
      </div>
    )
  }

  if (pageError) {
    return (
      <div className="space-y-3">
        <PageHeader title="Projects" />
        <ErrorState message={pageError} onRetry={fetchProjects} />
      </div>
    )
  }

  const monthLabel = new Date(thisMonth + 'T00:00:00').toLocaleDateString('en-NG', { month: 'long', year: 'numeric' })
  const todayDate = toDateOnly(new Date())

  return (
    <div className="space-y-3 pb-6">
      <PageHeader
        title="Projects"
        meta="Milestones by month"
        actions={
          <Button icon="plus" onClick={openAdd}>
            New
          </Button>
        }
      />

      {candidates.length > 0 && (
        <Panel label="Carry over" tone="warn">
          <div className="flex items-center justify-between gap-3">
            <p className="text-body-sm text-foreground min-w-0">
              {candidates.length} unfinished project{candidates.length === 1 ? '' : 's'} from{' '}
              {candidates.length === 1 ? 'last month' : 'earlier months'}
            </p>
            <Button size="sm" onClick={carryOver} loading={carrying}>
              {carrying ? 'Carrying…' : 'Carry over'}
            </Button>
          </div>
        </Panel>
      )}

      <Panel label={monthLabel} meta="This month">
        <div className="grid grid-cols-4 gap-3">
          <Stat label="Total" value={counts.total} />
          <Stat label="Active" value={counts.active} />
          <Stat label="Coding" value={counts.coding} />
          <Stat label="Hands-on" value={counts.handsOn} />
        </div>
      </Panel>

      <Segmented
        tabs
        full
        idPrefix="projects"
        label="Project views"
        options={TABS.map((t) => ({ value: t.id, label: t.label }))}
        value={tab}
        onChange={setTab}
      />

      <div role="tabpanel" id={`projects-panel-${tab}`} aria-labelledby={`projects-tab-${tab}`} className="space-y-3">
        {visible.length === 0 ? (
          <Panel>
            <EmptyState
              title={tab === 'all' ? 'No projects yet' : 'Nothing in this tab'}
              message={
                tab === 'all'
                  ? 'Name the thing you are building this month, break it into milestones, and tick them off as you go'
                  : 'Try a different tab, or start a project'
              }
              actionLabel="New project"
              onAction={openAdd}
            />
          </Panel>
        ) : (
          visible.map((project) => {
            const rows = byProject.get(project.id) || []
            const progress = milestoneProgress(rows)
            const typeMeta = TYPES.find((t) => t.value === project.type)
            const isComplete = project.status === 'complete'

            return (
              <Panel
                key={project.id}
                flush
                label={
                  <span className="inline-flex items-center gap-2">
                    <Icon name={typeMeta?.icon || 'project'} size={16} />
                    {typeMeta?.label || 'Project'}
                  </span>
                }
                meta={monthKey(project.month)}
              >
                <div className="flex items-start justify-between gap-2 pl-3 pr-1 pt-2">
                  <div className="min-w-0 py-1.5">
                    <h3 className={`text-heading truncate ${isComplete ? 'text-muted' : 'text-foreground'}`}>{project.name}</h3>
                    {(isComplete || project.carried_from) && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        {isComplete && <Badge label="Complete" tone="accent" />}
                        {project.carried_from && <Badge label={`From ${monthKey(project.carried_from)}`} tone="warn" />}
                      </div>
                    )}
                    {project.stack && <p className="type-data text-muted-dim mt-1 truncate">{project.stack}</p>}
                    {project.description && <p className="text-body-sm text-muted mt-1">{project.description}</p>}
                  </div>
                  <div className="flex shrink-0">
                    <IconButton name="edit" label={`Edit ${project.name}`} onClick={() => openEdit(project)} />
                    <IconButton name="trash" label={`Delete ${project.name}`} onClick={() => setConfirmDeleteId(project.id)} />
                  </div>
                </div>

                {rows.length > 0 && (
                  <>
                    <div className="px-3 pt-2 pb-3 space-y-2">
                      <div className="flex items-baseline justify-between type-data text-muted">
                        <span>
                          {progress.done} of {progress.total} milestone{progress.total === 1 ? '' : 's'}
                        </span>
                        <span>{Math.round(progress.share * 100)}%</span>
                      </div>
                      <ProgressBar value={progress.share * 100} label={`${project.name} milestones`} />
                    </div>
                    <div className="border-t border-border">
                      <ListRows label={`${project.name} milestones`}>
                        {rows.map((m) => {
                          const overdue = !m.completed && m.due_date && m.due_date < todayDate
                          return (
                            <ListRow
                              key={m.id}
                              onClick={() => toggleMilestone(m)}
                              label={`${m.title}, ${m.completed ? 'done' : 'not done'}`}
                              leading={<TaskCheck locked done={Boolean(m.completed)} />}
                              title={<span className={m.completed ? 'text-muted line-through' : ''}>{m.title}</span>}
                              meta={
                                m.due_date && (
                                  <span className={overdue ? 'text-danger' : ''}>
                                    {overdue ? 'Overdue · ' : 'Due '}
                                    {formatDate(m.due_date)}
                                  </span>
                                )
                              }
                            />
                          )
                        })}
                      </ListRows>
                    </div>
                  </>
                )}

                {project.done_criteria && (
                  <p className="text-body-sm text-muted px-3 py-3 border-t border-border">
                    <span className="text-muted-dim">Done when:</span> {project.done_criteria}
                  </p>
                )}

                <div className="p-3 border-t border-border space-y-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    full
                    icon={isComplete ? 'undo' : 'check'}
                    onClick={() => setStatus(project, isComplete ? 'active' : 'complete')}
                  >
                    {isComplete ? 'Reopen' : 'Mark complete'}
                  </Button>

                  {confirmDeleteId === project.id && (
                    <div role="alert" className="space-y-2">
                      <p className="flex items-center gap-2 text-body-sm text-danger">
                        <StatusDot status="danger" />
                        Delete this project and its milestones?
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <Button variant="danger" size="sm" icon="trash" onClick={() => handleDelete(project.id)}>
                          Delete
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => setConfirmDeleteId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </Panel>
            )
          })
        )}
      </div>

      {/* Add / Edit */}
      <Sheet isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Edit project' : 'New project'} desktopCenter>
        <form onSubmit={handleSave} className={`p-4 space-y-4 overflow-y-auto ${shake ? 'animate-shake' : ''}`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-title text-foreground">{editing ? 'Edit project' : 'New project'}</h2>
            <IconButton name="close" label="Close" onClick={() => setShowModal(false)} className="-mr-3" />
          </div>

          {formError && (
            <p role="alert" className="flex items-center gap-2 text-body-sm text-danger">
              <StatusDot status="danger" />
              {formError}
            </p>
          )}

          <Field label="Type">
            {() => (
              <Segmented
                full
                label="Project type"
                options={TYPES.map((t) => ({
                  value: t.value,
                  label: (
                    <span className="inline-flex items-center gap-2">
                      <Icon name={t.icon} size={16} />
                      {t.label}
                    </span>
                  ),
                }))}
                value={form.type}
                onChange={(type) => setForm({ ...form, type })}
              />
            )}
          </Field>

          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="What are you building?"
            required
          />

          <Input
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional"
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label={form.type === 'coding' ? 'Stack' : 'Materials'}
              value={form.stack}
              onChange={(e) => setForm({ ...form, stack: e.target.value })}
              placeholder={form.type === 'coding' ? 'React, Supabase' : 'Optional'}
            />
            <Input
              label="Done when"
              value={form.done_criteria}
              onChange={(e) => setForm({ ...form, done_criteria: e.target.value })}
              placeholder="It ships"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label as="p">Milestones</Label>
              <Button
                variant="ghost"
                size="sm"
                icon="plus"
                onClick={() => setForm((f) => ({ ...f, milestones: [...f.milestones, newMilestone()] }))}
              >
                Add
              </Button>
            </div>
            {form.milestones.length === 0 ? (
              <p className="text-body-sm text-muted-dim">Break it into steps you can tick off.</p>
            ) : (
              <div className="divide-y divide-border border border-border rounded-control">
                {form.milestones.map((m) => (
                  <div key={m.key} className="px-3 py-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <TaskCheck
                        done={m.completed}
                        onClick={() => setMilestone(m.key, { completed: !m.completed })}
                        label={m.completed ? 'Mark not done' : 'Mark done'}
                      />
                      <input
                        value={m.title}
                        onChange={(e) => setMilestone(m.key, { title: e.target.value })}
                        placeholder="Milestone"
                        aria-label="Milestone"
                        className={`${controlClasses()} flex-1 min-w-0`}
                      />
                      <IconButton
                        name="close"
                        label="Remove milestone"
                        onClick={() => setForm((f) => ({ ...f, milestones: f.milestones.filter((x) => x.key !== m.key) }))}
                        className="-mr-3"
                      />
                    </div>
                    <div className="pl-9 pr-9">
                      <input
                        type="date"
                        value={m.due_date}
                        onChange={(e) => setMilestone(m.key, { due_date: e.target.value })}
                        aria-label="Due date"
                        className={controlClasses()}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Button type="submit" full loading={saving} disabled={justSaved}>
            {justSaved ? (
              <>
                <span className="inline-flex animate-check-pop" aria-hidden="true">
                  <Icon name="check" size={20} />
                </span>
                <span className="sr-only">Saved</span>
              </>
            ) : saving ? (
              'Saving…'
            ) : editing ? (
              'Save changes'
            ) : (
              'Add'
            )}
          </Button>
        </form>
      </Sheet>
    </div>
  )
}
