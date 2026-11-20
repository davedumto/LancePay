import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WEBHOOK_RETRY_CONFIG } from '@/lib/webhook-delivery'

const deliveryFindMany = vi.fn()
const deliveryUpdateMany = vi.fn()
const deliveryUpdate = vi.fn()
const webhookUpdate = vi.fn()
const sendWebhookDisabledEmail = vi.fn()
const fetchMock = vi.fn()

const tx = {
  webhookDelivery: { update: (...args: any[]) => deliveryUpdate(...args) },
  userWebhook: { update: (...args: any[]) => webhookUpdate(...args) },
}

vi.mock('@/lib/db', () => ({
  prisma: {
    webhookDelivery: {
      findMany: (...args: any[]) => deliveryFindMany(...args),
      updateMany: (...args: any[]) => deliveryUpdateMany(...args),
    },
    userWebhook: {
      update: (...args: any[]) => webhookUpdate(...args),
    },
    $transaction: (cb: any) => cb(tx),
  },
}))

vi.mock('@/lib/email', () => ({
  sendWebhookDisabledEmail: (...args: any[]) => sendWebhookDisabledEmail(...args),
}))

import { GET } from './route'

function makeRequest(secret: string | null = 'cron_secret') {
  const headers: Record<string, string> = {}
  if (secret !== null) headers.authorization = `Bearer ${secret}`
  return new Request('http://localhost/api/cron/process-webhook-retries', { headers })
}

function makeDelivery(overrides: Record<string, any> = {}) {
  return {
    id: 'del_1',
    webhookId: 'wh_1',
    eventType: 'invoice.paid',
    payload: '{"id":"inv_1"}',
    status: 'failed',
    attemptCount: 0,
    nextRetryAt: new Date(Date.now() - 1000),
    webhook: {
      id: 'wh_1',
      targetUrl: 'https://example.com/hook',
      signingSecret: 'secret',
      consecutiveFailures: 0,
      lastFailureAt: null,
      user: { email: 'dev@example.com', name: 'Dev' },
    },
    ...overrides,
  }
}

describe('GET /api/cron/process-webhook-retries (#1888)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.CRON_SECRET = 'cron_secret'
    vi.stubGlobal('fetch', fetchMock)
    deliveryUpdateMany.mockResolvedValue({ count: 1 })
    sendWebhookDisabledEmail.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects requests without the CRON_SECRET bearer token', async () => {
    const res = await GET(makeRequest('wrong'))
    expect(res.status).toBe(401)
    expect(deliveryFindMany).not.toHaveBeenCalled()
  })

  it('claims due deliveries with a conditional update before attempting', async () => {
    deliveryFindMany.mockResolvedValueOnce([makeDelivery()]).mockResolvedValueOnce([])
    fetchMock.mockResolvedValue({ status: 200 })

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    expect(deliveryUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'del_1',
        status: { in: ['pending', 'failed'] },
      }),
      data: expect.objectContaining({ attemptCount: { increment: 1 } }),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/hook')
    expect(init.method).toBe('POST')
    expect(init.headers['X-Webhook-Signature']).toBeTruthy()
  })

  it('marks a successful delivery as delivered and resets failures', async () => {
    deliveryFindMany.mockResolvedValueOnce([makeDelivery()]).mockResolvedValueOnce([])
    fetchMock.mockResolvedValue({ status: 204 })

    await GET(makeRequest())

    expect(deliveryUpdate).toHaveBeenCalledWith({
      where: { id: 'del_1' },
      data: expect.objectContaining({
        status: 'delivered',
        attemptCount: 1,
        nextRetryAt: null,
      }),
    })
    expect(webhookUpdate).toHaveBeenCalledWith({
      where: { id: 'wh_1' },
      data: expect.objectContaining({ consecutiveFailures: 0 }),
    })
  })

  it('schedules exponential backoff on failure', async () => {
    deliveryFindMany.mockResolvedValueOnce([makeDelivery({ attemptCount: 2 })]).mockResolvedValueOnce([])
    fetchMock.mockResolvedValue({ status: 500 })

    const before = Date.now()
    await GET(makeRequest())
    const after = Date.now()

    const update = deliveryUpdate.mock.calls[0][0]
    expect(update.data.status).toBe('failed')
    expect(update.data.attemptCount).toBe(3)
    // attemptCount-1 = 2 → base 5000 * 2^2 = 20000 + up to 1000 jitter
    const retryAt = update.data.nextRetryAt.getTime()
    expect(retryAt).toBeGreaterThanOrEqual(before + 20000)
    expect(retryAt).toBeLessThanOrEqual(after + 21000)
  })

  it('dead-letters deliveries that exhaust the retry cap', async () => {
    deliveryFindMany
      .mockResolvedValueOnce([
        makeDelivery({ attemptCount: WEBHOOK_RETRY_CONFIG.maxAttempts - 1 }),
      ])
      .mockResolvedValueOnce([])
    fetchMock.mockResolvedValue({ status: 500 })

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(deliveryUpdate).toHaveBeenCalledWith({
      where: { id: 'del_1' },
      data: expect.objectContaining({
        status: 'dead_lettered',
        nextRetryAt: null,
      }),
    })
    expect(body.deadLettered).toBe(1)
  })

  it('auto-disables the webhook and emails the owner at the failure threshold', async () => {
    deliveryFindMany
      .mockResolvedValueOnce([
        makeDelivery({
          webhook: {
            ...makeDelivery().webhook,
            consecutiveFailures: WEBHOOK_RETRY_CONFIG.consecutiveFailuresThreshold - 1,
          },
        }),
      ])
      .mockResolvedValueOnce([])
    fetchMock.mockResolvedValue({ status: 500 })

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(webhookUpdate).toHaveBeenCalledWith({
      where: { id: 'wh_1' },
      data: expect.objectContaining({
        consecutiveFailures: WEBHOOK_RETRY_CONFIG.consecutiveFailuresThreshold,
        status: 'INACTIVE',
        isActive: false,
      }),
    })
    expect(sendWebhookDisabledEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'dev@example.com',
        webhookUrl: 'https://example.com/hook',
        autoDisabled: true,
      }),
    )
    expect(body.disabled).toBe(1)
  })

  it('skips deliveries it fails to claim', async () => {
    deliveryFindMany.mockResolvedValueOnce([makeDelivery()]).mockResolvedValueOnce([])
    deliveryUpdateMany.mockResolvedValueOnce({ count: 0 })

    await GET(makeRequest())

    expect(fetchMock).not.toHaveBeenCalled()
    expect(deliveryUpdate).not.toHaveBeenCalled()
  })
})
