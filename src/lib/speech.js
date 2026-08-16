/**
 * Turning something said out loud into a list of tasks.
 *
 * Dictation is the right input for a morning: you know what the day holds
 * before you know how to phrase it, and typing three separate priorities into
 * three separate boxes is a small tax charged at exactly the moment you are
 * least willing to pay it.
 *
 * But speech arrives as one run-on string. "Um so today I need to finish the
 * planner tests and then call the bank, also chase the invoice" is three tasks
 * wearing one sentence, and writing it to a single row would make the feature
 * look like it worked while producing something you cannot tick off.
 *
 * Everything here is about that gap, and all of it is pure: the Web Speech API
 * hands over a transcript and this decides what it means, so the meaning is
 * testable without a microphone, a browser, or a person willing to talk to
 * their laptop.
 */

/**
 * Where one spoken task ends and the next begins.
 *
 * Ordered longest-first so "and then" is consumed before "and". Getting that
 * backwards leaves a stray "then" at the front of every second task.
 */
const SEPARATORS = [
  '\n',
  ' and then ',
  ' and after that ',
  ' after that ',
  ' then i ',
  ' then ',
  ' also i ',
  ' also ',
  ' plus ',
  '; ',
]

/**
 * Openings people say before the actual task, stripped from the front only.
 *
 * Front only, deliberately. "Remember to call the bank" starts with filler;
 * "write the bit that decides what to remember" does not, and a global replace
 * would quietly edit the middle of a real sentence.
 */
const LEAD_INS = [
  'um',
  'uh',
  'erm',
  'so',
  'okay',
  'ok',
  'right',
  'today i want to',
  'today i need to',
  'today im going to',
  "today i'm going to",
  'i want to',
  'i need to',
  'i have to',
  'i should',
  'i must',
  'im going to',
  "i'm going to",
  'going to',
  'remember to',
  'make sure to',
  'make sure i',
  "don't forget to",
  'dont forget to',
  'first',
  'firstly',
  'secondly',
  'thirdly',
  'next',
  'finally',
  'lastly',
]

/** Most tasks taken from one dictation. Beyond this it is a monologue, not a plan. */
export const MAX_SPOKEN_TASKS = 10

/** Longest a single task may be. Anything longer was never one task. */
const MAX_TASK_LENGTH = 120

/** Shortest thing worth writing down. "Um" and "yeah" are not tasks. */
const MIN_TASK_LENGTH = 3

/**
 * Is dictation available in this browser?
 *
 * Called for its answer, not trusted for its absence: `DictateDay` renders the
 * typed field either way and only adds the microphone when this is true. A
 * surface that offers dictation and silently does nothing on an unsupported
 * browser is this project's recurring failure shape -- a control that reports
 * success while doing nothing -- and Safari, Firefox and every in-app webview
 * are exactly where it would happen.
 *
 * @param {object} [w] - injected for testing; defaults to the real window
 * @returns {boolean}
 */
export function isSpeechSupported(w = typeof window === 'undefined' ? undefined : window) {
  if (!w) return false
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition)
}

/**
 * The constructor for this browser's speech recognition, or null.
 *
 * Chrome and every Chromium browser still expose it prefixed, and it has been
 * that way for a decade. Checking only the unprefixed name would disable
 * dictation for most of the people who can actually use it.
 *
 * @param {object} [w]
 */
export function speechRecognizer(w = typeof window === 'undefined' ? undefined : window) {
  if (!w) return null
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

/** Strip a leading filler phrase, repeatedly, until the text starts with content. */
function stripLeadIns(text) {
  let out = text
  let changed = true

  while (changed) {
    changed = false
    const lower = out.toLowerCase()

    for (const lead of LEAD_INS) {
      // Followed by a space or a comma, so "sofa" is never read as "so" + "fa".
      if (lower.startsWith(`${lead} `) || lower.startsWith(`${lead}, `)) {
        out = out.slice(lead.length).replace(/^[\s,]+/, '')
        changed = true
        break
      }
    }
  }

  return out
}

/** Split on every separator in turn, so one pass handles a mixed sentence. */
function splitOnSeparators(text) {
  let parts = [text]

  for (const sep of SEPARATORS) {
    const next = []
    for (const part of parts) {
      // Case-insensitively, because a transcript may or may not be capitalised
      // and "And then" is the same instruction as "and then".
      const lower = part.toLowerCase()
      let from = 0
      let at = lower.indexOf(sep, from)

      if (at === -1) {
        next.push(part)
        continue
      }

      while (at !== -1) {
        next.push(part.slice(from, at))
        from = at + sep.length
        at = lower.indexOf(sep, from)
      }
      next.push(part.slice(from))
    }
    parts = next
  }

  return parts
}

/**
 * Break a dictated paragraph into the tasks it contains.
 *
 * Conservative on purpose. It splits where a person clearly moved on -- "and
 * then", "also", a new line -- and does not try to split on commas, because
 * "call the bank, the one on Awolowo Road" is one task and "call the bank, chase
 * the invoice" is two, and nothing in the transcript distinguishes them. Under-
 * splitting leaves you editing one row; over-splitting leaves you deleting one
 * and re-typing another, which is worse.
 *
 * @param {string} transcript
 * @param {{max?: number}} [options]
 * @returns {Array<string>} cleaned task titles, in the order they were said
 */
export function parseSpokenTasks(transcript, { max = MAX_SPOKEN_TASKS } = {}) {
  if (typeof transcript !== 'string' || !transcript.trim()) return []

  const seen = new Set()
  const tasks = []

  for (const raw of splitOnSeparators(transcript)) {
    let task = stripLeadIns(String(raw).trim())

    // Trailing punctuation is an artefact of speaking, not part of the task.
    task = task.replace(/^[\s,.;:-]+/, '').replace(/[\s,.;:]+$/, '').trim()

    if (task.length < MIN_TASK_LENGTH) continue
    if (task.length > MAX_TASK_LENGTH) task = `${task.slice(0, MAX_TASK_LENGTH - 1)}…`

    // Capitalise the first letter, since transcripts often arrive lowercase and
    // the result sits beside tasks the user typed themselves.
    task = task[0].toUpperCase() + task.slice(1)

    const key = task.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    tasks.push(task)
    if (tasks.length >= max) break
  }

  return tasks
}
