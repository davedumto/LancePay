import { describe, it, expect, beforeEach } from 'vitest'
import { recordWebhookDelivery, getWebhookHistory, clearWebhookHistory } from '../_lib/webhook-history'

describe('Webhook History', () => {
  const webhookId = 'test-webhook-id'

  beforeEach(() => {
    clearWebhookHistory(webhookId)
  })

  it('should be empty initially', () => {
    const history = getWebhookHistory(webhookId)
    expect(history).toEqual([])
  })

  it('should record delivery attempts', () => {
    recordWebhookDelivery(webhookId, {
      eventId: 'evt-1',
      status: 'ok',
      latencyMs: 123,
      attempt: 1,
      bodyExcerpt: '{"foo":"bar"}'
    })

    const history = getWebhookHistory(webhookId)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      eventId: 'evt-1',
      status: 'ok',
      latencyMs: 123,
      attempt: 1,
      bodyExcerpt: '{"foo":"bar"}'
    })
    expect(history[0].ts).toBeDefined()
  })

  it('should return newest first', () => {
    recordWebhookDelivery(webhookId, {
      eventId: 'evt-1',
      status: 'ok',
      latencyMs: 100,
      attempt: 1,
      bodyExcerpt: '1'
    })
    recordWebhookDelivery(webhookId, {
      eventId: 'evt-2',
      status: 'fail',
      latencyMs: 200,
      attempt: 1,
      bodyExcerpt: '2'
    })

    const history = getWebhookHistory(webhookId)
    expect(history).toHaveLength(2)
    expect(history[0].eventId).toBe('evt-2')
    expect(history[1].eventId).toBe('evt-1')
  })

  it('should evict oldest entries at capacity', () => {
    for (let i = 1; i <= 105; i++) {
      recordWebhookDelivery(webhookId, {
        eventId: `evt-${i}`,
        status: 'ok',
        latencyMs: i,
        attempt: 1,
        bodyExcerpt: `${i}`
      })
    }

    const history = getWebhookHistory(webhookId)
    expect(history).toHaveLength(100)
    expect(history[0].eventId).toBe('evt-105')
    expect(history[99].eventId).toBe('evt-6')
  })

  it('should filter by status', () => {
    recordWebhookDelivery(webhookId, {
      eventId: 'evt-ok',
      status: 'ok',
      latencyMs: 10,
      attempt: 1,
      bodyExcerpt: 'ok'
    })
    recordWebhookDelivery(webhookId, {
      eventId: 'evt-fail',
      status: 'fail',
      latencyMs: 20,
      attempt: 1,
      bodyExcerpt: 'fail'
    })

    const all = getWebhookHistory(webhookId)
    expect(all).toHaveLength(2)

    const okOnly = getWebhookHistory(webhookId, 'ok')
    expect(okOnly).toHaveLength(1)
    expect(okOnly[0].eventId).toBe('evt-ok')

    const failOnly = getWebhookHistory(webhookId, 'fail')
    expect(failOnly).toHaveLength(1)
    expect(failOnly[0].eventId).toBe('evt-fail')
  })
})
