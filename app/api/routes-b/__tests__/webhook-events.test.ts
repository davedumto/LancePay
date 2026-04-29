import { describe, it, expect } from 'vitest'
import {
  VALID_EVENT_TYPES,
  isValidEventType,
  validateEventTypes,
  shouldTriggerWebhook,
  getDefaultEventTypes,
  WILDCARD_EVENT
} from '../_lib/webhook-events'

describe('webhook events', () => {
  describe('event type validation', () => {
    it('recognizes valid event types', () => {
      expect(isValidEventType('invoice.created')).toBe(true)
      expect(isValidEventType('invoice.paid')).toBe(true)
      expect(isValidEventType('withdrawal.completed')).toBe(true)
      expect(isValidEventType('*')).toBe(true)
    })

    it('rejects invalid event types', () => {
      expect(isValidEventType('invalid.event')).toBe(false)
      expect(isValidEventType('')).toBe(false)
      expect(isValidEventType('invoice')).toBe(false)
    })
  })

  describe('event types validation', () => {
    it('validates array of event types', () => {
      expect(validateEventTypes(['invoice.created', 'invoice.paid']))
        .toEqual(['invoice.created', 'invoice.paid'])
    })

    it('accepts wildcard', () => {
      expect(validateEventTypes(['*'])).toEqual(['*'])
    })

    it('defaults to wildcard for empty array', () => {
      expect(validateEventTypes([])).toEqual(['*'])
    })

    it('throws for invalid event type', () => {
      expect(() => validateEventTypes(['invalid.event']))
        .toThrow('Invalid event type: invalid.event')
    })

    it('throws for non-array input', () => {
      expect(() => validateEventTypes('not-an-array' as any))
        .toThrow('eventTypes must be an array')
    })
  })

  describe('webhook triggering', () => {
    it('triggers for wildcard', () => {
      expect(shouldTriggerWebhook(['*'], 'invoice.created')).toBe(true)
      expect(shouldTriggerWebhook(['*'], 'withdrawal.completed')).toBe(true)
    })

    it('triggers for matching event type', () => {
      expect(shouldTriggerWebhook(['invoice.created'], 'invoice.created')).toBe(true)
      expect(shouldTriggerWebhook(['invoice.created', 'invoice.paid'], 'invoice.paid')).toBe(true)
    })

    it('does not trigger for non-matching event type', () => {
      expect(shouldTriggerWebhook(['invoice.created'], 'invoice.paid')).toBe(false)
      expect(shouldTriggerWebhook(['withdrawal.completed'], 'invoice.created')).toBe(false)
    })

    it('handles mixed wildcard and specific events', () => {
      expect(shouldTriggerWebhook(['*', 'invoice.created'], 'invoice.created')).toBe(true)
      expect(shouldTriggerWebhook(['*', 'invoice.created'], 'invoice.paid')).toBe(true)
    })
  })

  describe('default event types', () => {
    it('returns wildcard for backwards compatibility', () => {
      expect(getDefaultEventTypes()).toEqual(['*'])
    })
  })

  describe('constants', () => {
    it('has valid event types constant', () => {
      expect(VALID_EVENT_TYPES).toContain('invoice.created')
      expect(VALID_EVENT_TYPES).toContain('invoice.paid')
      expect(VALID_EVENT_TYPES).toContain('invoice.cancelled')
      expect(VALID_EVENT_TYPES).toContain('withdrawal.completed')
      expect(VALID_EVENT_TYPES).toContain('withdrawal.failed')
    })

    it('has wildcard constant', () => {
      expect(WILDCARD_EVENT).toBe('*')
    })
  })
})