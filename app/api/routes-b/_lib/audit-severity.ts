export type AuditSeverity = 'info' | 'warn' | 'critical'

const severityMap: Record<string, AuditSeverity> = {
  'invoice.created': 'info',
  'invoice.paid': 'info',
  'invoice.deleted': 'critical',
  'invoice.disputed': 'critical',
  'webhook.failed': 'warn',
  'withdrawal.completed': 'info',
  'withdrawal.failed': 'warn',
  'bank_account.created': 'info',
  'bank_account.deleted': 'warn',
  'user.login': 'info',
  'user.logout': 'info',
  'user.password_changed': 'warn',
  'user.2fa_enabled': 'info',
  'user.2fa_disabled': 'critical',
}

export function getSeverity(eventType: string): AuditSeverity {
  return severityMap[eventType] || 'info'
}

export function getEventTypesForSeverity(severity: string): string[] {
  return Object.entries(severityMap)
    .filter(([_, s]) => s === severity)
    .map(([eventType]) => eventType)
}

export function buildSeverityFilter(severity: string | null) {
  if (!severity) return {}
  
  if (severity === 'info') {
    const nonInfoEvents = Object.entries(severityMap)
      .filter(([_, s]) => s !== 'info')
      .map(([eventType]) => eventType)
    return { eventType: { notIn: nonInfoEvents } }
  }
  
  const eventTypes = getEventTypesForSeverity(severity)
  if (eventTypes.length === 0) {
    return { eventType: { in: ['__NONE__'] } }
  }
  
  return { eventType: { in: eventTypes } }
}
