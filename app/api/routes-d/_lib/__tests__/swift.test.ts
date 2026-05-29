import { describe, it, expect } from 'vitest'
import { validateSWIFT } from '../swift'

describe('validateSWIFT', () => {
  it('validates an 8-character SWIFT code', () => {
    expect(validateSWIFT('DEUTDEFF')).toBe(true)
    expect(validateSWIFT('MARKDEFF')).toBe(true)
  })

  it('validates an 11-character SWIFT code', () => {
    expect(validateSWIFT('DEUTDEFF500')).toBe(true)
    expect(validateSWIFT('MARKDEFFXXX')).toBe(true)
  })

  it('rejects invalid length', () => {
    expect(validateSWIFT('DEUTD')).toBe(false)
    expect(validateSWIFT('DEUTDEFF5000')).toBe(false)
  })

  it('rejects invalid format', () => {
    expect(validateSWIFT('DEUT1234567')).toBe(false)
    expect(validateSWIFT('12UTDEFF500')).toBe(false)
  })

  it('handles spaces', () => {
    expect(validateSWIFT('DEUT DEFF 500')).toBe(true)
  })

  it('handles lowercase', () => {
    expect(validateSWIFT('deutdeff500')).toBe(true)
  })
})
