/**
 * Tests for validateTagName — Issue #610
 */

import { describe, it, expect } from 'vitest'
import { validateTagName } from '../tag-validation'

describe('validateTagName (#610)', () => {
  it('accepts a valid name', () => {
    const result = validateTagName('Important')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('Important')
  })

  it('trims whitespace', () => {
    const result = validateTagName('  spaced  ')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('spaced')
  })

  it('rejects non-string input', () => {
    expect(validateTagName(null).ok).toBe(false)
    expect(validateTagName(123).ok).toBe(false)
    expect(validateTagName(undefined).ok).toBe(false)
  })

  it('rejects empty string', () => {
    expect(validateTagName('').ok).toBe(false)
    expect(validateTagName('   ').ok).toBe(false)
  })

  it('rejects names longer than 32 chars', () => {
    expect(validateTagName('x'.repeat(33)).ok).toBe(false)
  })

  it('accepts names exactly 32 chars', () => {
    expect(validateTagName('x'.repeat(32)).ok).toBe(true)
  })

  it('rejects control characters', () => {
    expect(validateTagName('bad\x00name').ok).toBe(false)
    expect(validateTagName('bad\x07name').ok).toBe(false)
  })
})
