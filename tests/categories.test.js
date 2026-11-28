import { describe, it, expect, beforeEach } from 'vitest'
import {
  setCustomCategories,
  resetCustomCategories,
  customCategories,
  groupedCategories,
  allCategories,
  isBuiltIn,
  isCustom,
  validateCategoryName,
  CUSTOM_SECTION,
  NAME_MAX,
  CUSTOM_CATEGORY_ICONS,
  resolveIcon,
  LEGACY_ICON_MAP,
} from '../src/lib/categories.js'
import { CATEGORIES, ALL_CATEGORIES, getCategoryIcon, isIconName, GOAL_ICONS, CATEGORY_ICONS } from '../src/lib/constants.js'

beforeEach(() => resetCustomCategories())

describe('the empty store -- a database behind 030', () => {
  it('offers exactly the built-in list', () => {
    expect(customCategories()).toEqual([])
    expect(allCategories()).toEqual(ALL_CATEGORIES)
    expect(groupedCategories()).toEqual(CATEGORIES)
  })

  it('returns copies, so a caller cannot edit the built-ins through it', () => {
    groupedCategories().Essentials.push('Nope')
    expect(CATEGORIES.Essentials).not.toContain('Nope')
  })
})

describe('setCustomCategories', () => {
  it('adds names under their own heading after every built-in section', () => {
    setCustomCategories([
      { id: 'a', name: 'Pets', icon: 'paw' },
      { id: 'b', name: 'Baby', section: 'Custom' },
    ])
    const grouped = groupedCategories()
    expect(Object.keys(grouped).at(-1)).toBe(CUSTOM_SECTION)
    expect(grouped[CUSTOM_SECTION]).toEqual(['Pets', 'Baby'])
    expect(allCategories().slice(-2)).toEqual(['Pets', 'Baby'])
  })

  it('files a row under a built-in section when it names one', () => {
    setCustomCategories([{ id: 'a', name: 'Gym', section: 'Health' }])
    expect(groupedCategories().Health.at(-1)).toBe('Gym')
    expect(groupedCategories()[CUSTOM_SECTION]).toBeUndefined()
  })

  it('drops blanks, duplicates by case, and anything shadowing a built-in', () => {
    setCustomCategories([
      { id: 'a', name: '  Pets ' },
      { id: 'b', name: 'pets' },
      { id: 'c', name: '' },
      { id: 'd', name: 'transport' },
      { id: 'e', name: null },
      null,
    ])
    expect(customCategories().map((c) => c.name)).toEqual(['Pets'])
  })

  it('registers icons so getCategoryIcon answers for custom names, as glyph names', () => {
    expect(getCategoryIcon('Pets')).toBe('box')
    setCustomCategories([{ id: 'a', name: 'Pets', icon: 'paw' }, { id: 'b', name: 'Baby' }])
    expect(getCategoryIcon('Pets')).toBe('paw')
    expect(getCategoryIcon('Baby')).toBe('box')
    // Built-ins are never overridden by a registered icon.
    expect(getCategoryIcon('Transport')).toBe('car')
    resetCustomCategories()
    expect(getCategoryIcon('Pets')).toBe('box')
  })

  it('maps an emoji stored before the glyph set, and never returns a raw stored value', () => {
    setCustomCategories([
      { id: 'a', name: 'Pets', icon: '\u{1F43E}' }, // paw prints
      { id: 'b', name: 'Gym', icon: '\u{1F3CB}\u{FE0F}' }, // weight lifter, with VS16
      { id: 'c', name: 'Odd', icon: 'something else' },
    ])
    expect(getCategoryIcon('Pets')).toBe('paw')
    expect(getCategoryIcon('Gym')).toBe('gym')
    expect(getCategoryIcon('Odd')).toBe('tag')
  })

  it('answers isCustom by case, and never for a built-in', () => {
    setCustomCategories([{ id: 'a', name: 'Pets' }])
    expect(isCustom('pets')).toBe(true)
    expect(isCustom('Transport')).toBe(false)
    expect(isBuiltIn('transport')).toBe(true)
    expect(isBuiltIn('Pets')).toBe(false)
  })
})

describe('validateCategoryName', () => {
  it('trims and collapses whitespace on a good name', () => {
    expect(validateCategoryName('  Pet   Food ')).toEqual({ ok: true, name: 'Pet Food' })
  })

  it('refuses a blank', () => {
    expect(validateCategoryName('').ok).toBe(false)
    expect(validateCategoryName('   ').ok).toBe(false)
    expect(validateCategoryName(null).ok).toBe(false)
  })

  it('refuses a name longer than the column allows', () => {
    expect(validateCategoryName('x'.repeat(NAME_MAX)).ok).toBe(true)
    expect(validateCategoryName('x'.repeat(NAME_MAX + 1)).ok).toBe(false)
  })

  it('refuses a built-in name in any case', () => {
    const result = validateCategoryName('TRANSPORT')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/built-in/)
  })

  it('refuses a name already in the store, by case', () => {
    setCustomCategories([{ id: 'a', name: 'Pets' }])
    expect(validateCategoryName('pets').ok).toBe(false)
    expect(validateCategoryName('Pets', []).ok).toBe(true)
  })
})

describe('the icon list', () => {
  it('is non-empty and has no duplicates', () => {
    expect(CUSTOM_CATEGORY_ICONS.length).toBeGreaterThan(0)
    expect(new Set(CUSTOM_CATEGORY_ICONS).size).toBe(CUSTOM_CATEGORY_ICONS.length)
  })

  it('is glyph names that fit goals.icon and categories.icon (8 characters)', () => {
    for (const name of CUSTOM_CATEGORY_ICONS) {
      expect(isIconName(name)).toBe(true)
      expect(name.length).toBeLessThanOrEqual(8)
    }
  })
})

describe('resolveIcon', () => {
  it('returns a known glyph name as is', () => {
    expect(resolveIcon('cart')).toBe('cart')
    expect(resolveIcon('goal', 'tag')).toBe('goal')
  })

  it('maps every legacy emoji to a real glyph', () => {
    for (const [emoji, glyph] of Object.entries(LEGACY_ICON_MAP)) {
      expect(isIconName(glyph)).toBe(true)
      expect(resolveIcon(emoji)).toBe(glyph)
    }
    expect(resolveIcon('\u{1F3AF}', 'goal')).toBe('goal') // direct hit
    expect(resolveIcon('\u{1F6E0}\u{FE0F}')).toBe('repair') // with VS16
    expect(resolveIcon('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}')).toBe('users') // ZWJ family
  })

  it('falls back for anything else', () => {
    expect(resolveIcon(null)).toBe('tag')
    expect(resolveIcon('')).toBe('tag')
    expect(resolveIcon('not-a-glyph', 'goal')).toBe('goal')
    expect(resolveIcon('\u{1F984}', 'goal')).toBe('goal') // an emoji with no mapping
  })
})

describe('built-in and goal icons', () => {
  it('are glyph names of 8 characters or fewer', () => {
    for (const name of [...Object.values(CATEGORY_ICONS), ...GOAL_ICONS]) {
      expect(isIconName(name)).toBe(true)
      expect(name.length).toBeLessThanOrEqual(8)
    }
  })
})
