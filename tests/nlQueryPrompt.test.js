import { describe, it, expect } from 'vitest'
import { buildNlQueryPrompt, NL_QUERY_SYSTEM_PROMPT } from '../src/lib/nlQueryPrompt.js'
import { describeQueries, QUERY_NAMES } from '../src/lib/nlQuery.js'

describe('NL_QUERY_SYSTEM_PROMPT', () => {
  it('demands an exact function name and forbids the model answering directly', () => {
    expect(NL_QUERY_SYSTEM_PROMPT).toMatch(/EXACTLY/)
    expect(NL_QUERY_SYSTEM_PROMPT).toMatch(/Do not answer the question yourself/)
  })

  it('allows declining when no function fits', () => {
    expect(NL_QUERY_SYSTEM_PROMPT).toMatch(/"function": null/)
  })
})

describe('buildNlQueryPrompt', () => {
  it('lists every function runQuery will accept, by name', () => {
    const prompt = buildNlQueryPrompt('How much did I spend on transport?')
    for (const name of QUERY_NAMES) {
      expect(prompt).toContain(name)
    }
  })

  it('states each function\'s declared arguments, not invented ones', () => {
    const prompt = buildNlQueryPrompt('question')
    const byCategory = describeQueries().find((q) => q.name === 'spendByCategory')
    expect(prompt).toContain(`${byCategory.name}(category: string)`)
  })

  it('marks a function with no arguments as taking none', () => {
    const prompt = buildNlQueryPrompt('question')
    expect(prompt).toContain('spendThisMonth(no arguments)')
  })

  it('includes the question asked, trimmed', () => {
    const prompt = buildNlQueryPrompt('  How much is in GTBank?  ')
    expect(prompt).toContain('QUESTION')
    expect(prompt).toContain('How much is in GTBank?')
  })

  it('states plainly when no question was given, rather than an empty line', () => {
    expect(buildNlQueryPrompt('')).toContain('(none given)')
    expect(buildNlQueryPrompt(undefined)).toContain('(none given)')
  })
})
