import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWebhookPostIdempotencyKey,
  clearIdempotencyStore,
  getIdempotentResponse,
  setIdempotentResponse,
} from '../idempotency'

describe('routes-d idempotency', () => {
  beforeEach(() => {
    clearIdempotencyStore()
    vi.useRealTimers()
  })

  it('scopes webhook POST keys per user', () => {
    expect(buildWebhookPostIdempotencyKey('user-1', 'key-a')).toBe(
      'routes-d:webhooks:user-1:key-a',
    )
    expect(buildWebhookPostIdempotencyKey('user-2', 'key-a')).not.toBe(
      buildWebhookPostIdempotencyKey('user-1', 'key-a'),
    )
  })

  it('expires entries after TTL', () => {
    vi.useFakeTimers()
    const key = buildWebhookPostIdempotencyKey('user-1', 'key-a')
    setIdempotentResponse(key, { bodyHash: 'abc', status: 201, body: { id: 'wh-1' } }, 1_000)
    expect(getIdempotentResponse(key)).toEqual(
      expect.objectContaining({ status: 201, body: { id: 'wh-1' } }),
    )
    vi.advanceTimersByTime(1_001)
    expect(getIdempotentResponse(key)).toBeNull()
  })
})
