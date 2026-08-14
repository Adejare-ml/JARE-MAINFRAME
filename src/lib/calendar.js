/**
 * What is already in the day before you plan it.
 *
 * The arithmetic in planning.js divides a monthly target by the days left and
 * asks for a share of each one. That is correct, and on a Tuesday with six
 * hours of meetings it is also useless -- the number was computed without
 * looking at the day it is asking about, so missing it reads as a personal
 * failure rather than as a plan made in the dark.
 *
 * This is the looking. Pure over a list of calendar events, so every rule below
 * is testable without Google, a network, or a token.
 *
 * The rule that earns the module: **overlapping meetings are merged before
 * anything is counted.** A 10:00-11:00 call and a 10:30-11:30 call cost you
 * ninety minutes, not two hours, and a naive sum reports a day as fuller than
 * it is -- then quietly tells you there is no time to work when there is.
 */

/** The window a working day is measured inside, in minutes from local midnight. */
export const DAY_START_MINUTES = 9 * 60
export const DAY_END_MINUTES = 18 * 60

/** Most events kept in a brief. Beyond this it is a diary, not a shape. */
const MAX_EVENTS = 12

/**
 * Google's event object, reduced to what any of this cares about.
 *
 * An all-day event carries `start.date`; a timed one carries `start.dateTime`.
 * The distinction matters more than it looks: an all-day event is usually a
 * label ("Ramadan", "Lagos trip"), not four hundred and forty minutes of
 * unavailability, and counting it as busy would report every such day as
 * completely full.
 *
 * @param {object} raw - an item from calendar.events.list
 * @returns {{id: string, title: string, start: string|null, end: string|null, allDay: boolean, declined: boolean}|null}
 */
export function normaliseEvent(raw) {
  if (!raw || raw.status === 'cancelled') return null

  const allDay = Boolean(raw.start?.date && !raw.start?.dateTime)

  // `self` is the entry for the calendar's owner. Declining a meeting is a
  // decision that it is not happening to you, and counting it as busy would
  // hold time you have already freed.
  const me = (raw.attendees || []).find((a) => a?.self)
  const declined = me?.responseStatus === 'declined'

  return {
    id: raw.id || '',
    title: String(raw.summary || '(no title)').slice(0, 120),
    start: raw.start?.dateTime || raw.start?.date || null,
    end: raw.end?.dateTime || raw.end?.date || null,
    allDay,
    declined,
  }
}

/**
 * Minutes from local midnight for an instant, at a fixed offset from UTC.
 *
 * The same shift trick as src/lib/repo.js, and here for the same reason: this
 * runs on a UTC runner about a person in Lagos, and reading the hour in UTC
 * would place a 09:00 meeting at 08:00 and let it fall outside the working
 * window entirely.
 *
 * @returns {number|null} 0-1439, or null if the timestamp is unusable
 */
export function minutesIntoDay(iso, offsetMinutes = 60) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const shifted = new Date(t + offsetMinutes * 60000)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/** The local calendar date of an instant, at a fixed offset. */
export function localDay(iso, offsetMinutes = 60) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return new Date(t + offsetMinutes * 60000).toISOString().slice(0, 10)
}

/**
 * Collapse overlapping and touching intervals into the time they actually take.
 *
 * The heart of the module. Exported because it is the part most worth testing
 * on its own, and the part whose absence produces a number that looks right.
 *
 * @param {Array<{from: number, to: number}>} intervals
 * @returns {Array<{from: number, to: number}>} disjoint, in order
 */
export function mergeIntervals(intervals) {
  const sorted = (intervals || [])
    .filter((i) => i && Number.isFinite(i.from) && Number.isFinite(i.to) && i.to > i.from)
    .sort((a, b) => a.from - b.from)

  const merged = []
  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    // `>=` rather than `>`: a meeting ending at 11:00 and one starting at 11:00
    // are one continuous block of busy, and treating them as two would leave a
    // zero-minute gap counted as free time.
    if (last && interval.from <= last.to) {
      last.to = Math.max(last.to, interval.to)
    } else {
      merged.push({ from: interval.from, to: interval.to })
    }
  }

  return merged
}

/**
 * The shape of one day: what is fixed, how much is spoken for, what is left.
 *
 * Events are clipped to the working window rather than dropped. A meeting from
 * 08:00 to 10:00 takes an hour out of a day that starts at 09:00, and either
 * ignoring it or counting the whole two hours would be wrong in opposite
 * directions.
 *
 * @param {Array<object>} rawEvents - items from calendar.events.list
 * @param {{date: string, offsetMinutes?: number, dayStart?: number, dayEnd?: number}} options
 * @returns {{events: Array<object>, busyMinutes: number, freeMinutes: number, firstFreeMinute: number|null}}
 */
export function summariseDay(
  rawEvents,
  { date, offsetMinutes = 60, dayStart = DAY_START_MINUTES, dayEnd = DAY_END_MINUTES } = {},
) {
  const windowMinutes = Math.max(0, dayEnd - dayStart)

  const events = []
  const intervals = []

  for (const raw of rawEvents || []) {
    const event = normaliseEvent(raw)
    if (!event || event.declined || !event.start) continue

    // All-day entries are kept as context and contribute no busy time. They are
    // usually a label on the day rather than a claim on it.
    if (event.allDay) {
      if (event.start === date) events.push(event)
      continue
    }

    if (localDay(event.start, offsetMinutes) !== date) continue

    const from = minutesIntoDay(event.start, offsetMinutes)
    const to = event.end ? minutesIntoDay(event.end, offsetMinutes) : null
    if (from == null) continue

    events.push(event)

    // An end before its start means the event runs past midnight; clip it to
    // the end of the window rather than producing a negative interval that
    // would subtract from the busy total.
    const rawTo = to == null || to < from ? dayEnd : to
    const clippedFrom = Math.max(dayStart, from)
    const clippedTo = Math.min(dayEnd, rawTo)
    if (clippedTo > clippedFrom) intervals.push({ from: clippedFrom, to: clippedTo })
  }

  const merged = mergeIntervals(intervals)
  const busyMinutes = merged.reduce((sum, i) => sum + (i.to - i.from), 0)

  // The first minute of the window not already spoken for -- where the day's
  // work can actually start. null when the window is full.
  let firstFreeMinute = dayStart
  for (const interval of merged) {
    if (firstFreeMinute < interval.from) break
    firstFreeMinute = Math.max(firstFreeMinute, interval.to)
  }
  if (firstFreeMinute >= dayEnd) firstFreeMinute = null

  events.sort((a, b) => String(a.start).localeCompare(String(b.start)))

  return {
    events: events.slice(0, MAX_EVENTS),
    busyMinutes,
    freeMinutes: Math.max(0, windowMinutes - busyMinutes),
    firstFreeMinute,
  }
}

/**
 * Minutes as something a person reads. 200 -> "3h 20m".
 *
 * @param {number} minutes
 * @returns {string}
 */
export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0))
  const hours = Math.floor(total / 60)
  const mins = total % 60

  if (hours === 0) return `${mins}m`
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

/** Minutes from midnight as a clock time. 545 -> "09:05". */
export function formatClock(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return ''
  const h = Math.floor(minutes / 60) % 24
  const m = Math.round(minutes) % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
