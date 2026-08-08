import { describe, it, expect } from 'vitest'
import {
  buildBatchPrompt,
  formatCorrections,
  formatBatch,
  parseBatchResponse,
  chunk,
  BATCH_SIZE,
  MAX_CORRECTION_EXAMPLES,
  CATEGORIZE_SYSTEM_PROMPT,
} from '../src/lib/sync/batchPrompt.js'
import { ALL_CATEGORIES } from '../src/lib/constants.js'

const items = [
  { id: 'a', type: 'debit', amount: 2600, recipient: 'REJOICE ENE JOSEPH', walletName: 'Opay' },
  { id: 'b', type: 'credit', amount: 150000, description: 'TRF FROM ANNALYXX GLOBAL' },
]

describe('CATEGORIZE_SYSTEM_PROMPT', () => {
  // Interpolated from the app's constants so the prompt cannot drift from what
  // the UI can display.
  it('carries the real category list, including the new ones', () => {
    expect(CATEGORIZE_SYSTEM_PROMPT).toContain('Feeding / Groceries')
    expect(CATEGORIZE_SYSTEM_PROMPT).toContain('Savings')
    expect(CATEGORIZE_SYSTEM_PROMPT).toContain('Investment')
    for (const category of ALL_CATEGORIES) {
      expect(CATEGORIZE_SYSTEM_PROMPT).toContain(category)
    }
  })

  it('asks for explanation and confidence', () => {
    expect(CATEGORIZE_SYSTEM_PROMPT).toContain('explanation')
    expect(CATEGORIZE_SYSTEM_PROMPT).toContain('confidence')
  })
})

describe('formatBatch', () => {
  it('states direction in words rather than jargon', () => {
    const text = formatBatch(items)
    expect(text).toContain('money out 2600')
    expect(text).toContain('money in 150000')
  })

  it('includes the id, counterparty and wallet', () => {
    const text = formatBatch(items)
    expect(text).toContain('id: a')
    expect(text).toContain('REJOICE ENE JOSEPH')
    expect(text).toContain('via Opay')
  })

  it('omits fields that are absent rather than printing null', () => {
    const text = formatBatch([{ id: 'x', type: 'debit', amount: 5 }])
    expect(text).not.toContain('null')
    expect(text).not.toContain('undefined')
  })

  it('truncates a pathological narration', () => {
    const text = formatBatch([{ id: 'x', type: 'debit', amount: 5, description: 'z'.repeat(1000) }])
    expect(text.length).toBeLessThan(400)
  })

  it('handles an empty list', () => {
    expect(formatBatch([])).toBe('')
    expect(formatBatch(null)).toBe('')
  })
})

describe('formatCorrections', () => {
  it('renders past corrections as examples', () => {
    const text = formatCorrections([
      { recipient: 'REJOICE ENE JOSEPH', corrected_category: 'Family Support' },
    ])
    expect(text).toContain('REJOICE ENE JOSEPH')
    expect(text).toContain('Family Support')
  })

  it('falls back to the description when there is no recipient', () => {
    const text = formatCorrections([
      { description_snippet: 'MTN VTU', corrected_category: 'Airtime & Data' },
    ])
    expect(text).toContain('MTN VTU')
  })

  it('caps the number of examples so the prompt stays small', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      recipient: `person ${i}`,
      corrected_category: 'Transport',
    }))
    const lines = formatCorrections(many).split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(MAX_CORRECTION_EXAMPLES)
  })

  it('skips corrections with nothing to key on', () => {
    expect(formatCorrections([{ corrected_category: 'Transport' }])).toBe('')
  })

  it('returns nothing when there are no corrections', () => {
    expect(formatCorrections([])).toBe('')
    expect(formatCorrections(null)).toBe('')
  })
})

describe('buildBatchPrompt', () => {
  it('states how many transactions it is asking about', () => {
    expect(buildBatchPrompt(items, [])).toContain('2 transaction')
  })

  it('includes corrections when present and omits the section when not', () => {
    expect(buildBatchPrompt(items, [{ recipient: 'X', corrected_category: 'Rent' }])).toContain(
      'corrected your categories before',
    )
    expect(buildBatchPrompt(items, [])).not.toContain('corrected your categories before')
  })
})

describe('parseBatchResponse', () => {
  it('reads a well-formed response', () => {
    const results = parseBatchResponse(
      {
        results: [
          { id: 'a', category: 'Family Support', explanation: 'Transfer to Rejoice.', confidence: 'HIGH' },
          { id: 'b', category: 'Uncategorized', explanation: 'Salary, unclear.', confidence: 'LOW' },
        ],
      },
      items,
    )

    expect(results[0]).toEqual({
      id: 'a',
      category: 'Family Support',
      explanation: 'Transfer to Rejoice.',
      confidence: 'HIGH',
      known: true,
    })
    expect(results[1].confidence).toBe('LOW')
  })

  // The guarantee the sync depends on: one answer per question, always.
  it('returns one result per requested item even from an empty response', () => {
    for (const response of [null, {}, { results: [] }, { results: 'nonsense' }, 'not json']) {
      const results = parseBatchResponse(response, items)
      expect(results).toHaveLength(2)
      expect(results.map((r) => r.id)).toEqual(['a', 'b'])
      expect(results.every((r) => r.category === 'Uncategorized' && r.confidence === 'LOW')).toBe(true)
    }
  })

  // One bad entry must not cost the other nine their categories.
  it('keeps good entries when one is malformed', () => {
    const results = parseBatchResponse(
      {
        results: [
          { id: 'a', category: 'Transport', explanation: 'Bolt ride.', confidence: 'HIGH' },
          { id: 'b', category: 'Crypto Gambling', confidence: 'HIGH' },
        ],
      },
      items,
    )

    expect(results[0].category).toBe('Transport')
    expect(results[0].confidence).toBe('HIGH')
    expect(results[1].category).toBe('Uncategorized')
    expect(results[1].known).toBe(false)
  })

  // A model that invents a category cannot also be confident about it.
  it('refuses HIGH confidence on an invented category', () => {
    const results = parseBatchResponse(
      { results: [{ id: 'a', category: 'Nonsense', confidence: 'HIGH' }] },
      [items[0]],
    )
    expect(results[0].confidence).toBe('LOW')
  })

  it('fills in for an item the model skipped entirely', () => {
    const results = parseBatchResponse(
      { results: [{ id: 'a', category: 'Transport', confidence: 'HIGH' }] },
      items,
    )
    expect(results[1].id).toBe('b')
    expect(results[1].category).toBe('Uncategorized')
  })

  it('ignores entries for ids it was never asked about', () => {
    const results = parseBatchResponse(
      { results: [{ id: 'ghost', category: 'Rent', confidence: 'HIGH' }] },
      [items[0]],
    )
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('a')
  })

  it('tolerates a bare array instead of {results}', () => {
    const results = parseBatchResponse([{ id: 'a', category: 'Rent', confidence: 'HIGH' }], [items[0]])
    expect(results[0].category).toBe('Rent')
  })

  it('tolerates numeric ids returned as numbers', () => {
    const results = parseBatchResponse({ results: [{ id: 1, category: 'Rent', confidence: 'HIGH' }] }, [
      { id: '1', type: 'debit', amount: 1 },
    ])
    expect(results[0].category).toBe('Rent')
  })

  it('drops a blank explanation rather than storing an empty string', () => {
    const results = parseBatchResponse(
      { results: [{ id: 'a', category: 'Rent', explanation: '   ', confidence: 'HIGH' }] },
      [items[0]],
    )
    expect(results[0].explanation).toBeNull()
  })

  it('truncates a runaway explanation', () => {
    const results = parseBatchResponse(
      { results: [{ id: 'a', category: 'Rent', explanation: 'x'.repeat(5000), confidence: 'HIGH' }] },
      [items[0]],
    )
    expect(results[0].explanation.length).toBe(300)
  })
})

describe('chunk', () => {
  it('splits into batches of the configured size', () => {
    const batches = chunk(Array.from({ length: 25 }, (_, i) => i))
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(BATCH_SIZE)
    expect(batches[2]).toHaveLength(5)
  })

  it('handles an exact multiple and an empty list', () => {
    expect(chunk(Array.from({ length: 20 }, (_, i) => i))).toHaveLength(2)
    expect(chunk([])).toEqual([])
    expect(chunk(null)).toEqual([])
  })
})
