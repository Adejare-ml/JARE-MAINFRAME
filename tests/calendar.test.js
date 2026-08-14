import { describe, it, expect } from 'vitest'
import {
  normaliseEvent,
  minutesIntoDay,
  localDay,
  mergeIntervals,
  summariseDay,
  formatDuration,
  formatClock,
  DAY_START_MINUTES,
  DAY_END_MINUTES,
} from '../src/lib/calendar.js'

/**
 * The point of reading the calendar at all is to stop the app asking for a
 * share of a day it never looked at. That only works if the number it produces
 * is honest, so most of these tests are about the ways a busy-time figure can
 * be quietly wrong: double-counted overlaps, all-day labels treated as blocks,
 * meetings you declined, and hours read in the wrong timezone.
 */

const timed = (title, startISO, endISO, over = {}) => ({
  id: title,
  summary: title,
  start: { dateTime: startISO },
  end: { dateTime: endISO },
  ...over,
})

/** 2026-08-17 is a Monday. All times below are Lagos (UTC+1). */
const DAY = '2026-08-17'
const at = (h, m = 0) => {
  const utcHour = h - 1 // Lagos is UTC+1
  return `2026-08-17T${String(utcHour).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`
}

describe('mergeIntervals', () => {
  it('does not count overlapping meetings twice', () => {
    // The rule the module exists for. 10:00-11:00 and 10:30-11:30 cost ninety
    // minutes, not two hours -- and a naive sum reports the day as fuller than
    // it is, then tells you there is no time to work when there is.
    const merged = mergeIntervals([
      { from: 600, to: 660 },
      { from: 630, to: 690 },
    ])
    expect(merged).toEqual([{ from: 600, to: 690 }])
  })

  it('joins two meetings that touch', () => {
    // Back to back is one continuous block. Treating them as two leaves a
    // zero-minute gap that would be reported as free time.
    expect(mergeIntervals([{ from: 600, to: 660 }, { from: 660, to: 720 }])).toEqual([
      { from: 600, to: 720 },
    ])
  })

  it('keeps genuinely separate blocks apart', () => {
    expect(mergeIntervals([{ from: 600, to: 660 }, { from: 700, to: 760 }])).toHaveLength(2)
  })

  it('swallows a meeting entirely inside another', () => {
    expect(mergeIntervals([{ from: 540, to: 720 }, { from: 600, to: 660 }])).toEqual([
      { from: 540, to: 720 },
    ])
  })

  it('sorts before merging, so input order cannot change the answer', () => {
    const forward = mergeIntervals([{ from: 600, to: 660 }, { from: 630, to: 690 }])
    const backward = mergeIntervals([{ from: 630, to: 690 }, { from: 600, to: 660 }])
    expect(forward).toEqual(backward)
  })

  it('drops zero-length and reversed intervals rather than counting them', () => {
    expect(mergeIntervals([{ from: 600, to: 600 }, { from: 700, to: 650 }, null])).toEqual([])
  })
})

describe('minutesIntoDay', () => {
  it('reads the hour in Lagos, not in UTC', () => {
    // A 09:00 Lagos meeting is 08:00 UTC. Reading it as 08:00 would put it
    // outside a 09:00-18:00 working window and lose an hour of real booking.
    expect(minutesIntoDay('2026-08-17T08:00:00Z', 60)).toBe(9 * 60)
  })

  it('agrees with UTC at a zero offset', () => {
    expect(minutesIntoDay('2026-08-17T08:00:00Z', 0)).toBe(8 * 60)
  })

  it('returns null for junk instead of NaN', () => {
    expect(minutesIntoDay('not a time')).toBe(null)
  })
})

describe('localDay', () => {
  it('credits a late meeting to the day it happens on locally', () => {
    // 00:30 Tuesday in Lagos is 23:30 Monday in UTC -- the same off-by-one that
    // already bit this app with transaction_date and commit timestamps.
    expect(localDay('2026-08-17T23:30:00Z', 60)).toBe('2026-08-18')
  })
})

describe('normaliseEvent', () => {
  it('marks an all-day entry as such', () => {
    const e = normaliseEvent({ id: 'x', summary: 'Lagos trip', start: { date: DAY }, end: { date: DAY } })
    expect(e.allDay).toBe(true)
  })

  it('spots a meeting you declined', () => {
    const e = normaliseEvent(
      timed('Standup', at(10), at(10, 30), { attendees: [{ self: true, responseStatus: 'declined' }] }),
    )
    expect(e.declined).toBe(true)
  })

  it('does not read someone else’s decline as yours', () => {
    // Without the `self` check, one colleague declining would free your morning.
    const e = normaliseEvent(
      timed('Review', at(10), at(11), {
        attendees: [{ responseStatus: 'declined' }, { self: true, responseStatus: 'accepted' }],
      }),
    )
    expect(e.declined).toBe(false)
  })

  it('drops a cancelled event', () => {
    expect(normaliseEvent({ id: 'x', status: 'cancelled', start: { dateTime: at(10) } })).toBe(null)
  })

  it('survives an event with no title', () => {
    expect(normaliseEvent({ id: 'x', start: { dateTime: at(10) } }).title).toBe('(no title)')
  })
})

describe('summariseDay', () => {
  const opts = { date: DAY, offsetMinutes: 60 }

  it('reports what is booked and what is left', () => {
    const day = summariseDay([timed('Client call', at(10), at(11))], opts)
    expect(day.busyMinutes).toBe(60)
    expect(day.freeMinutes).toBe(DAY_END_MINUTES - DAY_START_MINUTES - 60)
    expect(day.events).toHaveLength(1)
  })

  it('does not double-count an overlapping pair', () => {
    const day = summariseDay(
      [timed('A', at(10), at(11)), timed('B', at(10, 30), at(11, 30))],
      opts,
    )
    expect(day.busyMinutes).toBe(90)
  })

  it('clips a meeting that starts before the working day', () => {
    // 08:00-10:00 takes one hour out of a day that begins at 09:00. Ignoring it
    // and counting all two hours are wrong in opposite directions.
    const day = summariseDay([timed('Early', at(8), at(10))], opts)
    expect(day.busyMinutes).toBe(60)
  })

  it('clips a meeting that runs past the end of it', () => {
    const day = summariseDay([timed('Late', at(17), at(20))], opts)
    expect(day.busyMinutes).toBe(60)
  })

  it('counts an all-day entry as context, not as a full day booked', () => {
    // "Ramadan" or "Lagos trip" is a label on the day, not nine hours of
    // unavailability -- and counting it as busy would report every such day as
    // completely full and stop the app suggesting anything at all.
    const day = summariseDay(
      [{ id: 'x', summary: 'Lagos trip', start: { date: DAY }, end: { date: DAY } }],
      opts,
    )
    expect(day.busyMinutes).toBe(0)
    expect(day.events).toHaveLength(1)
  })

  it('ignores a meeting you declined', () => {
    const day = summariseDay(
      [timed('Optional', at(10), at(12), { attendees: [{ self: true, responseStatus: 'declined' }] })],
      opts,
    )
    expect(day.busyMinutes).toBe(0)
    expect(day.events).toHaveLength(0)
  })

  it('ignores events belonging to a different day', () => {
    const day = summariseDay([timed('Tomorrow', '2026-08-18T09:00:00Z', '2026-08-18T10:00:00Z')], opts)
    expect(day.events).toHaveLength(0)
  })

  it('says when the first uninterrupted stretch starts', () => {
    // Not the same as "how much is free". A day with 09:00-12:00 booked has
    // five hours free, but none of them before lunch.
    const day = summariseDay([timed('Morning', at(9), at(12))], opts)
    expect(day.firstFreeMinute).toBe(12 * 60)
  })

  it('reports no free start at all when the window is full', () => {
    const day = summariseDay([timed('All of it', at(9), at(18))], opts)
    expect(day.firstFreeMinute).toBe(null)
    expect(day.freeMinutes).toBe(0)
  })

  it('gives an empty day the whole window', () => {
    const day = summariseDay([], opts)
    expect(day.busyMinutes).toBe(0)
    expect(day.freeMinutes).toBe(DAY_END_MINUTES - DAY_START_MINUTES)
    expect(day.firstFreeMinute).toBe(DAY_START_MINUTES)
  })

  it('never reports negative free time', () => {
    const day = summariseDay(
      [timed('A', at(9), at(18)), timed('B', at(9), at(18))],
      opts,
    )
    expect(day.freeMinutes).toBe(0)
  })

  it('survives junk in the event list', () => {
    const day = summariseDay([null, {}, timed('Real', at(10), at(11))], opts)
    expect(day.busyMinutes).toBe(60)
  })
})

describe('formatting', () => {
  it('writes minutes the way a person says them', () => {
    expect(formatDuration(200)).toBe('3h 20m')
    expect(formatDuration(120)).toBe('2h')
    expect(formatDuration(45)).toBe('45m')
    expect(formatDuration(0)).toBe('0m')
  })

  it('never shows a negative duration', () => {
    expect(formatDuration(-30)).toBe('0m')
  })

  it('writes a clock time with both digits', () => {
    expect(formatClock(9 * 60 + 5)).toBe('09:05')
    expect(formatClock(18 * 60)).toBe('18:00')
    expect(formatClock(null)).toBe('')
  })
})
