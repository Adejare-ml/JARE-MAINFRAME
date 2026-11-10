import { describe, it, expect } from 'vitest'
import { SPEECH_LANGS, fallbackSpeechLang } from '../src/lib/speech.js'

// Food dictation tries Nigerian English, then US English (Diet module, Phase 2).

describe('fallbackSpeechLang', () => {
  it('tries en-NG first and falls back to en-US when the browser lacks it', () => {
    expect(SPEECH_LANGS[0]).toBe('en-NG')
    expect(fallbackSpeechLang('en-NG', 'language-not-supported')).toBe('en-US')
  })

  it('stops after en-US, and ignores errors that are not about the language', () => {
    expect(fallbackSpeechLang('en-US', 'language-not-supported')).toBe(null)
    expect(fallbackSpeechLang('en-NG', 'not-allowed')).toBe(null)
    expect(fallbackSpeechLang('en-NG', 'no-speech')).toBe(null)
  })
})
