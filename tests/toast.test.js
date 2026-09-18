import { describe, it, expect } from 'vitest'
import { toast } from '../src/lib/toast.js'

/** Subscribe, collect every event fired while listening, then unsubscribe. */
function capture(run) {
  const events = []
  const unsubscribe = toast.subscribe((e) => events.push(e))
  run()
  unsubscribe()
  return events
}

describe('toast', () => {
  it('uses the per-type default duration when none is given', () => {
    const [success, error, info] = capture(() => {
      toast.success('ok')
      toast.error('bad')
      toast.info('fyi')
    })
    expect(success.duration).toBe(3000)
    expect(error.duration).toBe(6000)
    expect(info.duration).toBe(5000)
  })

  it('still accepts a bare number as duration -- the original signature', () => {
    const [event] = capture(() => toast.success('ok', 1000))
    expect(event.duration).toBe(1000)
  })

  it('accepts an options object with a duration override', () => {
    const [event] = capture(() => toast.error('bad', { duration: 9999 }))
    expect(event.duration).toBe(9999)
  })

  it('has no colour or action by default', () => {
    const [event] = capture(() => toast.success('ok'))
    expect(event.color).toBeNull()
    expect(event.action).toBeNull()
  })

  it('carries an optional colour, for tinting with a category colour', () => {
    const [event] = capture(() => toast.success('₦500 logged', { color: 'bg-emerald-500' }))
    expect(event.color).toBe('bg-emerald-500')
  })

  it('carries an optional action, e.g. an Undo button', () => {
    const onClick = () => {}
    const [event] = capture(() =>
      toast.success('Transaction voided', { duration: 5000, action: { label: 'Undo', onClick } }),
    )
    expect(event.action).toEqual({ label: 'Undo', onClick })
  })

  it('stops delivering once unsubscribed', () => {
    const events = []
    const unsubscribe = toast.subscribe((e) => events.push(e))
    unsubscribe()
    toast.success('too late')
    expect(events).toHaveLength(0)
  })

  it('gives every event a distinct id', () => {
    const [a, b] = capture(() => {
      toast.success('one')
      toast.success('two')
    })
    expect(a.id).not.toBe(b.id)
  })
})
