import { describe, expect, test } from 'vitest'
import { getSeverity, buildSeverityFilter } from '../_lib/audit-severity'

describe('Audit Severity', () => {
  test('maps known event correctly', () => {
    expect(getSeverity('invoice.deleted')).toBe('critical')
    expect(getSeverity('invoice.created')).toBe('info')
  })

  test('unknown events default to info', () => {
    expect(getSeverity('some.random.event')).toBe('info')
  })

  test('builds prisma filter for warn', () => {
    const filter = buildSeverityFilter('warn')
    expect(filter.eventType?.in).toContain('webhook.failed')
  })
})
