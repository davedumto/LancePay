import { describe, expect, test } from 'vitest'
import { isSchemaCompatible } from '../_lib/schema-version'

describe('Schema Version Compat', () => {
  test('matches identical versions', () => {
    expect(isSchemaCompatible('1.0.0')).toBe(true)
  })

  test('rejects higher minor client versions', () => {
    expect(isSchemaCompatible('1.1.0')).toBe(false)
  })

  test('rejects different major versions', () => {
    expect(isSchemaCompatible('2.0.0')).toBe(false)
  })
})
