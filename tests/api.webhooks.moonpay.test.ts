import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signMoonPayWebhook } from '@/lib/moonpay-signature'

const mocks = vi.hoisted(() => ({
  invoiceFindUnique: vi.fn(),
  transaction: vi.fn(),
  sendPaymentReceivedEmail: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    invoice: { findUnique: mocks.invoiceFindUnique },
    $transaction: mocks.transaction,
  },
}))
vi.mock('@/lib/email', () => ({ sendPaymentReceivedEmail: mocks.sendPaymentReceivedEmail }))
vi.mock('@/lib/logger', () => ({
  logger: { info: mocks.loggerInfo, error: mocks.loggerError },
}))

import { POST } from '@/app/api/webhooks/moonpay/route'

const SECRET = 'wk_test_secret_123'
const URL = 'http://localhost/api/webhooks/moonpay'
const rawBody = JSON.stringify({
  type: 'transaction_completed',
  data: { status: 'completed', externalTransactionId: 'INV-2025-001' },
})

function makeRequest(raw: string, signature?: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature !== null) headers['moonpay-signature-v2'] = signature ?? signMoonPayWebhook(raw, Math.floor(Date.now() / 1000), SECRET)
  return new NextRequest(URL, { method: 'POST', headers, body: raw })
}

async function post(raw: string, signature?: string | null) {
  const { POST: handler } = await import('@/app/api/webhooks/moonpay/route')
  return handler(makeRequest(raw, signature))
}

describe('MoonPay webhook V2 signature verification', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MOONPAY_WEBHOOK_KEY = SECRET
    delete process.env.MOONPAY_WEBHOOK_TOLERANCE_SECONDS
    mocks.invoiceFindUnique.mockResolvedValue(null)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('accepts a valid Moonpay-Signature-V2 webhook', async () => {
    const response = await post(rawBody)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(mocks.invoiceFindUnique).toHaveBeenCalled()
  })

  it('rejects a tampered body', async () => {
    const signature = signMoonPayWebhook(rawBody, Math.floor(Date.now() / 1000), SECRET)
    const response = await post(rawBody.replace('INV-2025-001', 'INV-TAMPERED'), signature)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid signature' })
    expect(mocks.invoiceFindUnique).not.toHaveBeenCalled()
  })

  it('rejects a stale timestamp outside the tolerance window', async () => {
    const staleSignature = signMoonPayWebhook(rawBody, Math.floor(Date.now() / 1000) - 3600, SECRET)
    const response = await post(rawBody, staleSignature)
    expect(response.status).toBe(401)
    expect(mocks.invoiceFindUnique).not.toHaveBeenCalled()
  })

  it('rejects a missing signature header', async () => {
    const response = await post(rawBody, null)
    expect(response.status).toBe(401)
    expect(mocks.invoiceFindUnique).not.toHaveBeenCalled()
  })

  it('honors a configured tolerance when validating timestamps', async () => {
    process.env.MOONPAY_WEBHOOK_TOLERANCE_SECONDS = '7200'
    const olderSignature = signMoonPayWebhook(rawBody, Math.floor(Date.now() / 1000) - 3600, SECRET)
    const response = await post(rawBody, olderSignature)
    expect(response.status).toBe(200)
  })
})
