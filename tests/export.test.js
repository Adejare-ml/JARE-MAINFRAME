import { describe, it, expect } from 'vitest'
import { EXPORT_TABLES, PAGE_SIZE, BOM, columnsFor, csvCell, toCsv, fetchAll, buildBundle, filenameFor } from '../src/lib/export.js'

describe('EXPORT_TABLES', () => {
  it('never includes the table that holds a Google token', () => {
    expect(EXPORT_TABLES.map((t) => t.name)).not.toContain('integrations')
  })

  it('drops bank email bodies from the transactions CSV only', () => {
    const tx = EXPORT_TABLES.find((t) => t.name === 'transactions')
    expect(tx.csvOmit).toContain('raw_email')
    expect(EXPORT_TABLES.filter((t) => t.csvOmit?.length).map((t) => t.name)).toEqual(['transactions'])
  })

  it('names every table once, with a column to order by', () => {
    const names = EXPORT_TABLES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of EXPORT_TABLES) expect(typeof t.order).toBe('string')
  })
})

describe('columnsFor', () => {
  it('is the union of keys in first-seen order, minus what is omitted', () => {
    const rows = [{ a: 1, raw_email: 'x' }, { b: 2, a: 3 }, null]
    expect(columnsFor(rows, ['raw_email'])).toEqual(['a', 'b'])
  })

  it('is empty for no rows', () => {
    expect(columnsFor([])).toEqual([])
  })
})

describe('csvCell', () => {
  it('leaves plain values alone and blanks nulls', () => {
    expect(csvCell('Transport')).toBe('Transport')
    expect(csvCell(1500.5)).toBe('1500.5')
    expect(csvCell(true)).toBe('true')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('quotes commas, quotes and newlines, doubling inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
  })

  it('defuses a formula in a string but leaves a negative number a number', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    expect(csvCell('+2348012345678')).toBe("'+2348012345678")
    expect(csvCell('@handle')).toBe("'@handle")
    expect(csvCell('-not a number')).toBe("'-not a number")
    expect(csvCell(-2500)).toBe('-2500')
  })

  it('serialises jsonb values rather than printing [object Object]', () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
  })
})

describe('toCsv', () => {
  it('starts with a BOM, writes a header, and ends every line with CRLF', () => {
    const csv = toCsv([{ id: 1, note: 'x' }])
    expect(csv.startsWith(BOM)).toBe(true)
    expect(csv.slice(1)).toBe('id,note\r\n1,x\r\n')
  })

  it('fills a column a row lacks with an empty cell', () => {
    const csv = toCsv([{ a: 1 }, { b: 2 }])
    expect(csv.slice(1)).toBe('a,b\r\n1,\r\n,2\r\n')
  })

  it('respects an explicit column list', () => {
    expect(toCsv([{ a: 1, b: 2 }], ['b']).slice(1)).toBe('b\r\n2\r\n')
  })

  it('is just a header for no rows', () => {
    expect(toCsv([], ['id']).slice(1)).toBe('id\r\n')
  })
})

describe('fetchAll', () => {
  function tableOf(n) {
    const rows = Array.from({ length: n }, (_, i) => ({ id: i }))
    const calls = []
    const page = async (from, to) => {
      calls.push([from, to])
      return { data: rows.slice(from, to + 1), error: null }
    }
    return { page, calls }
  }

  it('reads past the thousand-row cap and stops on the first short page', async () => {
    const { page, calls } = tableOf(2 * PAGE_SIZE + 7)
    const rows = await fetchAll(page)
    expect(rows).toHaveLength(2 * PAGE_SIZE + 7)
    expect(calls).toEqual([
      [0, PAGE_SIZE - 1],
      [PAGE_SIZE, 2 * PAGE_SIZE - 1],
      [2 * PAGE_SIZE, 3 * PAGE_SIZE - 1],
    ])
  })

  it('makes exactly one request for an empty table', async () => {
    const { page, calls } = tableOf(0)
    expect(await fetchAll(page)).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('asks once more when a page is exactly full, since it cannot know it was the last', async () => {
    const { page, calls } = tableOf(PAGE_SIZE)
    expect(await fetchAll(page)).toHaveLength(PAGE_SIZE)
    expect(calls).toHaveLength(2)
  })

  it('surfaces an error rather than returning a partial table as complete', async () => {
    await expect(fetchAll(async () => ({ data: null, error: { message: 'boom' } }))).rejects.toEqual({ message: 'boom' })
  })
})

describe('buildBundle', () => {
  const tables = [{ name: 'wallets' }, { name: 'repairs' }, { name: 'broken' }]
  const fetchTable = async (t) => {
    if (t.name === 'repairs') throw { code: '42P01', message: 'relation "repairs" does not exist' }
    if (t.name === 'broken') throw new Error('network down')
    return [{ id: 'w1' }]
  }

  it('keeps every table it can read and records the rest as skipped, never throwing', async () => {
    const bundle = await buildBundle(tables, fetchTable, { exportedAt: new Date('2026-09-22T10:00:00Z') })
    expect(bundle.exported_at).toBe('2026-09-22T10:00:00.000Z')
    expect(bundle.app).toBe('jare-mainframe')
    expect(bundle.tables).toEqual({ wallets: [{ id: 'w1' }] })
    expect(bundle.skipped).toEqual([
      { table: 'repairs', reason: 'table does not exist yet (migration not run)' },
      { table: 'broken', reason: 'network down' },
    ])
  })
})

describe('filenameFor', () => {
  const day = new Date('2026-09-22T23:30:00Z')

  it('names a table file and the bundle by the day', () => {
    expect(filenameFor('transactions', 'csv', day)).toBe('jare-transactions-2026-09-22.csv')
    expect(filenameFor(null, 'json', day)).toBe('jare-mainframe-2026-09-22.json')
  })
})
