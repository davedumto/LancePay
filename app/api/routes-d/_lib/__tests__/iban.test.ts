import { describe, it, expect } from 'vitest'
import { validateIBAN } from '../iban'

describe('validateIBAN', () => {
  it('validates a correct IBAN', () => {
    expect(validateIBAN('DE89370400440532013000')).toBe(true)
    expect(validateIBAN('GB82WEST12345698765432')).toBe(true)
    expect(validateIBAN('FR1420041010050500013M026')).toBe(true)
  })

  it('rejects an invalid checksum', () => {
    expect(validateIBAN('DE89370400440532013001')).toBe(false)
  })

  it('rejects an IBAN with incorrect length', () => {
    expect(validateIBAN('DE8937040044053201')).toBe(false)
  })

  it('rejects an unknown country code', () => {
    expect(validateIBAN('XX89370400440532013000')).toBe(false)
  })

  it('handles IBANs with spaces', () => {
    expect(validateIBAN('DE89 3704 0044 0532 0130 00')).toBe(true)
  })

  it('handles lowercase input', () => {
    expect(validateIBAN('de89370400440532013000')).toBe(true)
  })
})
