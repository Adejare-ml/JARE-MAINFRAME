import { describe, it, expect } from 'vitest'
import { buildPlanPrompt, MAX_GAPS_SHOWN, PLAN_SYSTEM_PROMPT } from '../src/lib/planPrompt.js'

describe('buildPlanPrompt', () => {
  const goal = { title: 'Ship the ledger import' }

  it('names the goal, the week count and the repository text', () => {
    const prompt = buildPlanPrompt({ goal, repoText: 'src/lib/import.js -- 3 commits', gaps: [], weeks: 5 })
    expect(prompt).toContain('Goal for the month: Ship the ledger import')
    expect(prompt).toContain('This month has 5 weeks to plan. Number them 1 to 5.')
    expect(prompt).toContain('src/lib/import.js -- 3 commits')
  })

  it('says a month of one week in the singular', () => {
    expect(buildPlanPrompt({ goal, repoText: 'x', weeks: 1 })).toContain('has 1 week to plan')
  })

  // An empty section reads to a model as something it should fill in; a
  // stated absence reads as a fact.
  it('states that no gaps were logged rather than leaving the section blank', () => {
    const prompt = buildPlanPrompt({ goal, repoText: '' })
    expect(prompt).toContain('(none logged')
    expect(prompt).toContain('(no repository information available)')
  })

  it('lists each gap with its note trimmed', () => {
    const prompt = buildPlanPrompt({
      goal,
      repoText: 'x',
      gaps: [{ topic: 'RLS', note: 'a'.repeat(200) }, { topic: 'Deno' }],
    })
    expect(prompt).toContain('- RLS — ' + 'a'.repeat(160))
    expect(prompt).not.toContain('a'.repeat(161))
    expect(prompt).toContain('- Deno')
  })

  it('shows at most MAX_GAPS_SHOWN gaps', () => {
    const gaps = Array.from({ length: MAX_GAPS_SHOWN + 5 }, (_, i) => ({ topic: `gap-${i}` }))
    const prompt = buildPlanPrompt({ goal, repoText: 'x', gaps })
    expect(prompt).toContain(`gap-${MAX_GAPS_SHOWN - 1}`)
    expect(prompt).not.toContain(`gap-${MAX_GAPS_SHOWN}`)
  })

  it('tolerates a missing goal', () => {
    expect(buildPlanPrompt({ repoText: 'x' })).toContain('Goal for the month: (untitled)')
  })

  it('asks for citations copied verbatim, matching what reviewPlan checks', () => {
    expect(buildPlanPrompt({ goal, repoText: 'x' })).toContain('Cite by copying a path or a gap topic exactly as written above.')
    expect(PLAN_SYSTEM_PROMPT).toContain('{"weeks": []}')
  })
})
