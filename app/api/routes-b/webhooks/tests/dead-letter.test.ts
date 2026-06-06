import { describe, it, expect, beforeEach } from 'vitest'
import { deadLetterQueue, shouldDeadLetter, pushToDeadLetter } from '../../_lib/dead-letter'

describe('Dead Letter Queue', () => {
  beforeEach(() => {
    // Clear the queue before each test
    deadLetterQueue.clear('test-webhook-1')
    deadLetterQueue.clear('test-webhook-2')
  })

  describe('shouldDeadLetter', () => {
    it('should return true for failed deliveries with max retries', () => {
      expect(shouldDeadLetter('failed', 3)).toBe(true)
      expect(shouldDeadLetter('failed', 4)).toBe(true)
    })

    it('should return false for successful deliveries', () => {
      expect(shouldDeadLetter('success', 3)).toBe(false)
    })

    it('should return false for failed deliveries below max retries', () => {
      expect(shouldDeadLetter('failed', 1)).toBe(false)
      expect(shouldDeadLetter('failed', 2)).toBe(false)
    })
  })

  describe('pushToDeadLetter', () => {
    it('should add event to queue', () => {
      pushToDeadLetter('test-webhook-1', {
        eventType: 'invoice.created',
        payload: '{"id": "inv_123"}',
        lastError: 'Timeout',
        attemptCount: 3,
        lastStatusCode: 500,
      })

      const events = deadLetterQueue.list('test-webhook-1')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        webhookId: 'test-webhook-1',
        eventType: 'invoice.created',
        payload: '{"id": "inv_123"}',
        lastError: 'Timeout',
        attemptCount: 3,
        lastStatusCode: 500,
      })
      expect(events[0].id).toBeDefined()
      expect(events[0].timestamp).toBeInstanceOf(Date)
    })
  })

  describe('queue management', () => {
    it('should enforce per-webhook cap with FIFO eviction', () => {
      // Fill queue beyond the cap
      for (let i = 0; i < 1005; i++) {
        deadLetterQueue.push('test-webhook-1', {
          webhookId: 'test-webhook-1',
          eventType: 'test.event',
          payload: `{"index": ${i}}`,
          attemptCount: 3,
        })
      }

      const events = deadLetterQueue.list('test-webhook-1')
      expect(events).toHaveLength(1000) // Should be capped at 1000

      // First 5 events should be evicted (FIFO)
      expect(events[0].payload).toBe('{"index": 5}')
      expect(events[999].payload).toBe('{"index": 1004}')
    })

    it('should handle multiple webhooks separately', () => {
      deadLetterQueue.push('test-webhook-1', {
        webhookId: 'test-webhook-1',
        eventType: 'event.1',
        payload: '{"webhook": 1}',
        attemptCount: 3,
      })

      deadLetterQueue.push('test-webhook-2', {
        webhookId: 'test-webhook-2',
        eventType: 'event.2',
        payload: '{"webhook": 2}',
        attemptCount: 3,
      })

      const events1 = deadLetterQueue.list('test-webhook-1')
      const events2 = deadLetterQueue.list('test-webhook-2')

      expect(events1).toHaveLength(1)
      expect(events2).toHaveLength(1)
      expect(events1[0].payload).toBe('{"webhook": 1}')
      expect(events2[0].payload).toBe('{"webhook": 2}')
    })
  })

  describe('replay', () => {
    it('should remove and return specific event', () => {
      // Add multiple events
      deadLetterQueue.push('test-webhook-1', {
        webhookId: 'test-webhook-1',
        eventType: 'event.1',
        payload: '{"id": "1"}',
        attemptCount: 3,
      })

      deadLetterQueue.push('test-webhook-1', {
        webhookId: 'test-webhook-1',
        eventType: 'event.2',
        payload: '{"id": "2"}',
        attemptCount: 3,
      })

      const eventsBefore = deadLetterQueue.list('test-webhook-1')
      const eventIdToReplay = eventsBefore[0].id

      const replayedEvent = deadLetterQueue.replay('test-webhook-1', eventIdToReplay)
      const eventsAfter = deadLetterQueue.list('test-webhook-1')

      expect(replayedEvent).toBeDefined()
      expect(replayedEvent?.id).toBe(eventIdToReplay)
      expect(replayedEvent?.payload).toBe('{"id": "1"}')
      expect(eventsAfter).toHaveLength(1)
      expect(eventsAfter[0].payload).toBe('{"id": "2"}')
    })

    it('should return null for non-existent event', () => {
      const result = deadLetterQueue.replay('test-webhook-1', 'non-existent-id')
      expect(result).toBeNull()
    })

    it('should return null for non-existent webhook', () => {
      const result = deadLetterQueue.replay('non-existent-webhook', 'some-id')
      expect(result).toBeNull()
    })
  })

  describe('getStats', () => {
    it('should return accurate statistics', () => {
      // Add events to multiple webhooks
      for (let i = 0; i < 3; i++) {
        deadLetterQueue.push(`webhook-${i}`, {
          webhookId: `webhook-${i}`,
          eventType: 'test.event',
          payload: '{}',
          attemptCount: 3,
        })
      }

      deadLetterQueue.push('webhook-0', {
        webhookId: 'webhook-0',
        eventType: 'test.event',
        payload: '{}',
        attemptCount: 3,
      })

      const stats = deadLetterQueue.getStats()
      expect(stats.totalWebhooks).toBe(3)
      expect(stats.totalEvents).toBe(4)
    })
  })
})
