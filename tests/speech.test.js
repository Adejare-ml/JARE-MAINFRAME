import { describe, it, expect } from 'vitest'
import {
  parseSpokenTasks,
  isSpeechSupported,
  speechRecognizer,
  MAX_SPOKEN_TASKS,
} from '../src/lib/speech.js'

/**
 * Speech arrives as one run-on string. Writing it to a single row would make
 * the feature look like it worked while producing something you cannot tick
 * off -- which is this project's recurring failure shape, a control that
 * reports success and does nothing useful.
 *
 * The bias throughout is toward under-splitting. Leaving two tasks joined
 * costs you one edit; splitting one task into two costs a delete and a retype,
 * and makes the app look like it did not understand you.
 */

describe('parseSpokenTasks', () => {
  it('splits a sentence where the speaker moved on', () => {
    const tasks = parseSpokenTasks(
      'finish the planner tests and then call the bank also chase the invoice',
    )
    expect(tasks).toEqual(['Finish the planner tests', 'Call the bank', 'Chase the invoice'])
  })

  it('strips the run-up people say before the actual task', () => {
    expect(parseSpokenTasks('um so today I need to review the migration')).toEqual([
      'Review the migration',
    ])
  })

  it('strips several lead-ins stacked together', () => {
    // Transcripts really do come out like this.
    expect(parseSpokenTasks('okay so um I want to write the calendar tests')).toEqual([
      'Write the calendar tests',
    ])
  })

  it('does not eat a word that merely starts with a filler word', () => {
    // "so" must not turn "sort the invoices" into "rt the invoices". The
    // trailing space in the match is what prevents it, and it is the kind of
    // thing that silently corrupts one task in twenty without it.
    expect(parseSpokenTasks('sort the invoices')).toEqual(['Sort the invoices'])
    expect(parseSpokenTasks('finish the sofa assembly')).toEqual(['Finish the sofa assembly'])
  })

  it('consumes "and then" whole, leaving no stray "then"', () => {
    // Separators are tried longest-first for exactly this. Matching " and "
    // first would leave every second task starting with "then".
    const tasks = parseSpokenTasks('call the bank and then email Tunde')
    expect(tasks).toEqual(['Call the bank', 'Email Tunde'])
  })

  it('splits on new lines, so the typed fallback behaves the same way', () => {
    // The textarea is the baseline input, not a consolation prize -- one task
    // per line has to work identically to speaking them.
    expect(parseSpokenTasks('call the bank\nchase the invoice\n')).toEqual([
      'Call the bank',
      'Chase the invoice',
    ])
  })

  it('does NOT split on a comma', () => {
    // The judgement call this module is built around. "Call the bank, the one
    // on Awolowo Road" is one task and "call the bank, chase the invoice" is
    // two, and nothing in a transcript tells them apart. Under-splitting costs
    // an edit; over-splitting costs a delete and a retype.
    expect(parseSpokenTasks('call the bank, the one on Awolowo Road')).toEqual([
      'Call the bank, the one on Awolowo Road',
    ])
  })

  it('handles a list said out loud with "then"', () => {
    const tasks = parseSpokenTasks('first finish the tests then review the PR')
    expect(tasks).toEqual(['Finish the tests', 'Review the PR'])
  })

  it('leaves ordinals other than "then" joined, which is the deliberate limit', () => {
    // "finally", "next" and "lastly" are stripped as lead-ins but are NOT
    // separators, and that asymmetry is on purpose: " next " appears inside
    // "book the next appointment", and splitting there would turn one task into
    // two fragments. The cost is that a spoken list using "finally" stays
    // joined and you edit one row -- which is the cheaper mistake, and the same
    // trade as refusing to split on commas.
    expect(parseSpokenTasks('review the PR finally push it')).toEqual([
      'Review the PR finally push it',
    ])
    expect(parseSpokenTasks('book the next appointment')).toEqual(['Book the next appointment'])
  })

  it('drops noises that are not tasks', () => {
    expect(parseSpokenTasks('um and then uh')).toEqual([])
    expect(parseSpokenTasks('   ')).toEqual([])
  })

  it('drops a repeat of something already said', () => {
    // Speech recognition sometimes emits a phrase twice as it settles.
    expect(parseSpokenTasks('call the bank and then call the bank')).toEqual(['Call the bank'])
  })

  it('capitalises, since a transcript arrives lowercase and sits beside typed tasks', () => {
    expect(parseSpokenTasks('review the migration')[0]).toBe('Review the migration')
  })

  it('truncates a task nobody would read on a card', () => {
    const long = parseSpokenTasks(`review ${'x'.repeat(300)}`)[0]
    expect(long.length).toBeLessThanOrEqual(120)
    expect(long.endsWith('…')).toBe(true)
  })

  it('caps how many tasks one dictation can produce', () => {
    // Beyond this it is a monologue, not a plan -- and a day that arrives with
    // twenty items on it is a day you will ignore the list.
    const many = Array.from({ length: 30 }, (_, i) => `do thing number ${i}`).join(' and then ')
    expect(parseSpokenTasks(many).length).toBe(MAX_SPOKEN_TASKS)
  })

  it('survives being handed nothing', () => {
    for (const junk of [null, undefined, 42, {}, '']) {
      expect(parseSpokenTasks(junk)).toEqual([])
    }
  })
})

describe('isSpeechSupported', () => {
  it('is true when the browser exposes it unprefixed', () => {
    expect(isSpeechSupported({ SpeechRecognition: function () {} })).toBe(true)
  })

  it('is true for the prefixed name Chromium still uses', () => {
    // Checking only the unprefixed name would disable dictation for most of the
    // people who can actually use it.
    expect(isSpeechSupported({ webkitSpeechRecognition: function () {} })).toBe(true)
  })

  it('is false where it is genuinely missing', () => {
    // Firefox, most iOS webviews. The component renders the typed field either
    // way -- a mic button that silently does nothing is the failure this guards.
    expect(isSpeechSupported({})).toBe(false)
  })

  it('is false with no window at all, rather than throwing', () => {
    // Vitest runs these in Node. A module that throws on import in a
    // non-browser environment cannot be tested, and could not run in scripts/.
    expect(isSpeechSupported(undefined)).toBe(false)
  })
})

describe('speechRecognizer', () => {
  it('prefers the standard name and falls back to the prefixed one', () => {
    const std = function () {}
    const prefixed = function () {}
    expect(speechRecognizer({ SpeechRecognition: std, webkitSpeechRecognition: prefixed })).toBe(std)
    expect(speechRecognizer({ webkitSpeechRecognition: prefixed })).toBe(prefixed)
    expect(speechRecognizer({})).toBe(null)
  })
})
