/**
 * Draft tomorrow, so the morning starts from a correction rather than a blank
 * page.
 *
 * Runs overnight from .github/workflows/draft-day.yml. Reads the calendar,
 * works out what the day already has in it, and writes that down. It creates no
 * tasks and ticks nothing -- it establishes the shape of the day, and the
 * decisions stay yours.
 *
 * Why the shape is worth having at all: everything this app plans divides a
 * target by the days remaining and asks for a share of each one. That is
 * arithmetically right and, on a Tuesday with six hours of meetings, useless.
 * Missing a number computed without looking at the day reads as a personal
 * failure rather than as a plan made in the dark. This is the looking.
 *
 * The rule it is most careful about: **"I could not look" is not "there was
 * nothing there."** A token without the calendar scope, an API outage and a
 * genuinely empty Tuesday all produce zero events, and storing all three the
 * same way would have the app cheerfully report a clear day when it is blind.
 * `source` carries the difference, and 012's check constraint keeps it honest.
 */

import { createClient } from '@supabase/supabase-js'
import { summariseDay, formatDuration, formatClock } from '../src/lib/calendar.js'
import { toDateOnly } from '../src/lib/queries.js'
import {
  getAccessToken,
  hasScope,
  reconsentMessage,
  CALENDAR_SCOPE,
} from './google.mjs'
import { assertProgress } from './lib/assertProgress.mjs'

// ───────────────────────────────────────────────────────────────
// 1. Configuration
// ───────────────────────────────────────────────────────────────

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env

/** Minutes east of UTC that decide which local day an event falls on. */
const OFFSET_MINUTES = Number(process.env.DAY_TZ_OFFSET_MINUTES) || 60

/** The window a working day is measured inside. Overridable without a deploy. */
const DAY_START = Number(process.env.DAY_START_MINUTES) || 9 * 60
const DAY_END = Number(process.env.DAY_END_MINUTES) || 18 * 60

/** Which calendar. 'primary' is the one the account owns. */
const CALENDAR_ID = process.env.DAY_CALENDAR_ID || 'primary'

/**
 * How many days ahead to draft.
 *
 * Two, not one: the run happens at night, so "tomorrow" is the day that matters
 * -- and drafting the day after as well means a run that fails once does not
 * leave a hole, in the same spirit as the sync's fourteen-day re-check window.
 */
const DAYS_AHEAD = Number(process.env.DAY_DRAFT_DAYS) || 2

/**
 * Whose rows these are.
 *
 * Required, not optional, and that is the whole point. This script writes with
 * the service-role key, which bypasses RLS and has no `auth.uid()` -- so a row
 * it inserts without `user_id` is a row that migration 015's policy makes
 * invisible to you in the app, with no error anywhere. Treating this as
 * optional would turn a missing repository secret into silently vanishing data,
 * which is this project's signature failure.
 *
 * Get it from: select id from auth.users;
 */
const OWNER_USER_ID = process.env.OWNER_USER_ID

const missingVars = [
  ['OWNER_USER_ID', OWNER_USER_ID],
  ['GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID],
  ['GOOGLE_CLIENT_SECRET', GOOGLE_CLIENT_SECRET],
  ['GOOGLE_REFRESH_TOKEN', GOOGLE_REFRESH_TOKEN],
  ['SUPABASE_URL', SUPABASE_URL],
  ['SUPABASE_SERVICE_KEY', SUPABASE_SERVICE_KEY],
]
  .filter(([, value]) => !value)
  .map(([name]) => name)

if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`)
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

/** Local dates to draft, starting with tomorrow. */
function upcomingDates() {
  const dates = []
  for (let i = 1; i <= DAYS_AHEAD; i++) {
    const d = new Date()
    d.setDate(d.getDate() + i)
    dates.push(toDateOnly(d))
  }
  return dates
}

// ───────────────────────────────────────────────────────────────
// 2. Calendar
// ───────────────────────────────────────────────────────────────

/**
 * Every event touching a span of local days.
 *
 * `singleEvents` expands a recurring series into its occurrences -- without it
 * a weekly stand-up arrives as one master record with a recurrence rule this
 * has no business interpreting, and every stand-up would be invisible.
 */
async function fetchEvents(accessToken, { from, to }) {
  const shift = OFFSET_MINUTES * 60000
  const timeMin = new Date(Date.parse(`${from}T00:00:00.000Z`) - shift).toISOString()
  const timeMax = new Date(Date.parse(`${to}T23:59:59.999Z`) - shift).toISOString()

  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events` +
    `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
    '&singleEvents=true&orderBy=startTime&maxResults=250'

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })

  if (res.status === 403 || res.status === 401) {
    // Named rather than surfaced raw. Google's message for a scope problem
    // mentions neither the scope nor the fix.
    throw new Error(
      `Calendar returned ${res.status}. Most likely the token cannot read this ` +
        `calendar.\n${reconsentMessage(CALENDAR_SCOPE)}`,
    )
  }
  if (!res.ok) {
    throw new Error(`Calendar returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  return (await res.json()).items || []
}

// ───────────────────────────────────────────────────────────────
// 3. Run
// ───────────────────────────────────────────────────────────────

async function main() {
  const dates = upcomingDates()
  console.log(`🌙 Drafting ${dates[0]} → ${dates[dates.length - 1]}`)
  console.log(
    `   working window ${formatClock(DAY_START)}–${formatClock(DAY_END)} ` +
      `(UTC${OFFSET_MINUTES >= 0 ? '+' : ''}${OFFSET_MINUTES / 60})`,
  )

  let events = []
  let source = 'calendar'

  try {
    const { accessToken, grantedScopes } = await getAccessToken({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      refreshToken: GOOGLE_REFRESH_TOKEN,
    })

    // Checked before the call rather than after a 403, so the reason is the
    // scope rather than a status code.
    if (!hasScope(grantedScopes, CALENDAR_SCOPE)) {
      throw new Error(reconsentMessage(CALENDAR_SCOPE))
    }

    events = await fetchEvents(accessToken, { from: dates[0], to: dates[dates.length - 1] })
    console.log(`   ${events.length} event(s) in range\n`)
  } catch (err) {
    // Recorded, not fatal. A day the app could not see is a fact worth storing,
    // and it is a different fact from a day with nothing in it -- which is the
    // whole reason `source` exists.
    console.warn(`⚠️  Could not read the calendar: ${err.message}\n`)
    source = 'unavailable'
  }

  const rows = dates.map((date) => {
    if (source === 'unavailable') {
      return { brief_date: date, events: [], busy_minutes: 0, free_minutes: 0, source, user_id: OWNER_USER_ID }
    }

    const day = summariseDay(events, {
      date,
      offsetMinutes: OFFSET_MINUTES,
      dayStart: DAY_START,
      dayEnd: DAY_END,
    })

    return {
      brief_date: date,
      user_id: OWNER_USER_ID,
      events: day.events,
      busy_minutes: day.busyMinutes,
      free_minutes: day.freeMinutes,
      // An empty day is stated as empty rather than left to look like a failed
      // read. Both are zero events; only one of them means you are free.
      source: day.events.length === 0 ? 'empty' : 'calendar',
      drafted_at: new Date().toISOString(),
    }
  })

  const { error } = await supabase
    .from('day_briefs')
    .upsert(rows, { onConflict: 'brief_date' })

  if (error) throw error

  console.log('─'.repeat(64))
  for (const row of rows) {
    if (row.source === 'unavailable') {
      console.log(`${row.brief_date}  calendar unreadable — the app will say so rather than claim a clear day`)
      continue
    }

    const busy = formatDuration(row.busy_minutes)
    const free = formatDuration(row.free_minutes)
    const titles = (row.events || []).map((e) => e.title).slice(0, 3).join(', ')

    console.log(
      `${row.brief_date}  ${String(row.events.length).padStart(2)} fixed  ` +
        `${busy.padStart(6)} booked  ${free.padStart(6)} free` +
        (titles ? `  — ${titles}` : ''),
    )
  }
  console.log('─'.repeat(64))
  console.log(`✅ ${rows.length} day(s) drafted`)

  // Each row is honestly labelled 'unavailable' when the calendar could not be
  // read, which is exactly what `source` exists for -- but a caught exception
  // that never rethrows also means this ran to completion and exited 0, so
  // `if: failure()` never sees the one thing here actually worth an alert: the
  // token needs re-consenting.
  assertProgress([
    { ok: source !== 'unavailable', reason: 'could not read the calendar this run (see the warning above)' },
  ])
}

main().catch((err) => {
  console.error('❌ Day drafting failed:', err?.message || err)
  process.exit(1)
})
