import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signWebhookPayload } from '../hmac'
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  dispatchWebhookDelivery,
} from '../webhook-delivery'

const { webhookDeliveryCreate, webhookUpdate, fetchMock } = vi.hoisted(() => ({
  webhookDeliveryCreate: vi.fn(),
  webhookUpdate: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    webhookDelivery: { create: webhookDeliveryCreate },
    userWebhook: { update: webhookUpdate },
  },
}))
vi.mock('../../_shared/logger', () => ({ logger: { error: vi.fn() } }))

describe('routes-d dispatchWebhookDelivery', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    webhookDeliveryCreate.mockResolvedValue({})
    webhookUpdate.mockResolvedValue({})
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    vi.spyOn(Date, 'now').mockReturnValue(1_714_300_800_000)
  })

  it('sends HMAC signature and timestamp headers on delivery', async () => {
    const secret = 'b'.repeat(64)
    const payload = { id: 'evt_1', type: 'webhook.test' }
    const body = JSON.stringify(payload)
    const timestamp = '1714300800'
    const expectedSignature = signWebhookPayload(secret, timestamp, body)

    const result = await dispatchWebhookDelivery(
      {
        id: 'wh_1',
        targetUrl: 'https://example.test/webhook',
        signingSecret: secret,
      },
      'webhook.test',
      payload,
    )

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
      [WEBHOOK_SIGNATURE_HEADER]: expectedSignature,
    })
    expect(init.body).toBe(body)
    expect(webhookDeliveryCreate).toHaveBeenCalledOnce()
    expect(webhookUpdate).toHaveBeenCalledOnce()
  })

  it('records failed deliveries when upstream returns non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 })

    const result = await dispatchWebhookDelivery(
      {
        id: 'wh_1',
        targetUrl: 'https://example.test/webhook',
        signingSecret: 'c'.repeat(64),
      },
      'webhook.test',
      { id: 'evt_2' },
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe(502)
    expect(webhookDeliveryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', lastStatusCode: 502 }),
      }),
    )
  })
})
