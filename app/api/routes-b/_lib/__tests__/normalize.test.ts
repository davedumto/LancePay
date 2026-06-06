import { normalizeString } from '../normalize'

describe('normalizeString', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeString('  hello  ')).toBe('hello')
    expect(normalizeString('\thello\t')).toBe('hello')
    expect(normalizeString('\nhello\n')).toBe('hello')
  })

  it('collapses internal whitespace runs', () => {
    expect(normalizeString('hello   world')).toBe('hello world')
    expect(normalizeString('hello\t\tworld')).toBe('hello world')
    expect(normalizeString('hello\n\nworld')).toBe('hello world')
  })

  it('applies NFC normalization', () => {
    const withDiacritic = 'café' // é as single character (NFC)
    const withComposed = 'café' // e followed by combining acute
    expect(normalizeString(withComposed)).toBe(withDiacritic)
  })

  it('is idempotent', () => {
    const input = 'hello   world'
    const first = normalizeString(input)
    const second = normalizeString(first)
    expect(first).toBe(second)
  })

  it('handles empty string', () => {
    expect(normalizeString('')).toBe('')
    expect(normalizeString('   ')).toBe('')
  })

  it('preserves internal case', () => {
    expect(normalizeString('Hello World')).toBe('Hello World')
    expect(normalizeString('HELLO')).toBe('HELLO')
  })
})
