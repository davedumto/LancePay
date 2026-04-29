/**
 * Webhook event types and validation.
 */

export const VALID_EVENT_TYPES = [
  'invoice.created',
  'invoice.paid',
  'invoice.cancelled',
  'withdrawal.completed',
  'withdrawal.failed',
  'contact.created',
  'contact.updated',
  'bank_account.added',
  'bank_account.verified',
  'transaction.created',
  'transaction.completed',
  'transaction.failed'
] as const

export type EventType = typeof VALID_EVENT_TYPES[number] | '*'

export const WILDCARD_EVENT = '*' as const

/**
 * Check if an event type is valid.
 */
export function isValidEventType(eventType: string): eventType is EventType {
  return eventType === WILDCARD_EVENT || VALID_EVENT_TYPES.includes(eventType as any)
}

/**
 * Validate an array of event types.
 */
export function validateEventTypes(eventTypes: string[]): string[] {
  if (!Array.isArray(eventTypes)) {
    throw new Error('eventTypes must be an array')
  }

  if (eventTypes.length === 0) {
    return [WILDCARD_EVENT]
  }

  const validated: string[] = []
  for (const eventType of eventTypes) {
    if (!isValidEventType(eventType)) {
      throw new Error(`Invalid event type: ${eventType}`)
    }
    validated.push(eventType)
  }

  return validated
}

/**
 * Check if a webhook should be triggered for a given event.
 */
export function shouldTriggerWebhook(
  webhookEventTypes: string[],
  eventType: string
): boolean {
  // Always trigger if wildcard is present
  if (webhookEventTypes.includes(WILDCARD_EVENT)) {
    return true
  }

  // Check for exact match
  return webhookEventTypes.includes(eventType)
}

/**
 * Get default event types (wildcard for backwards compatibility).
 */
export function getDefaultEventTypes(): string[] {
  return [WILDCARD_EVENT]
}