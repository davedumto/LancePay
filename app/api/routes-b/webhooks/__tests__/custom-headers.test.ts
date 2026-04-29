import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

import {
  applyCustomHeaders,
  getCustomHeaders,
  isReservedHeader,
  resetCustomHeaderStore,
  setCustomHeaders,
  validateCustomHeaders,
} from '../../_lib/webhook-custom-headers'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    webhookDelivery: { create: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedWebhookFindUnique = vi.mocked(prisma.userWebhook.findUnique)
const mockedWebhookCount = vi.mocked(prisma.userWebhook.count)
const mockedWebhookCreate = vi.mocked(prisma.userWebhook.create)
const mockedWebhookUpdate = vi.mocked(prisma.userWebhook.update)
const mockedWebhookDelete = vi.mocked(prisma.userWebhook.delete)
const mockedDeliveryCreate = vi.mocked(prisma.webhookDelivery.create)

const fakeUser = { id: 'user-1', privyId: 'privy-1' }

beforeEach(() => {
  vi.resetAllMocks()
  resetCustomHeaderStore()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFindUnique.mockResolvedValue(fakeUser as never)
})

describe('validateCustomHeaders', () => {
  it('accepts an empty object or undefined', () => {
    expect(validateCustomHeaders({})).toEqual({ ok: true, headers: {} })
    expect(validateCustomHeaders(undefined)).toEqual({ ok: true, headers: {} })
    expect(validateCustomHeaders(null)).toEqual({ ok: true, headers: {} })
  })

  it('rejects non-object input', () => {
    const res = validateCustomHeaders([])
    expect(res.ok).toBe(false)
  })

  it('rejects more than 10 entries', () => {
    const headers: Record<string, string> = {}
    for (let i = 0; i < 11; i += 1) headers[`X-Header-${i}`] = String(i)
    const res = validateCustomHeaders(headers)
    expect(res.ok).toBe(false)
  })

  it('rejects values longer than 256 characters', () => {
    const res = validateCustomHeaders({ 'X-Big': 'a'.repeat(257) })
    expect(res.ok).toBe(false)
  })

  it('rejects reserved headers (case-insensitive)', () => {
    expect(validateCustomHeaders({ host: 'example.com' }).ok).toBe(false)
    expect(validateCustomHeaders({ HOST: 'example.com' }).ok).toBe(false)
    expect(validateCustomHeaders({ 'Content-Length': '10' }).ok).toBe(false)
    expect(validateCustomHeaders({ 'X-LancePay-Trace': 'x' }).ok).toBe(false)
    expect(validateCustomHeaders({ 'x-lancepay-anything': 'x' }).ok).toBe(false)
  })

  it('rejects invalid header names', () => {
    expect(validateCustomHeaders({ 'bad header': 'x' }).ok).toBe(false)
    expect(validateCustomHeaders({ '': 'x' }).ok).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(validateCustomHeaders({ 'X-Foo': 123 as unknown as string }).ok).toBe(false)
  })

  it('accepts a valid set of headers', () => {
    const res = validateCustomHeaders({
      'X-Tenant-Id': 'tenant-42',
      Authorization: 'Bearer xyz',
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(Object.keys(res.headers)).toHaveLength(2)
    }
  })

  it('isReservedHeader works regardless of case', () => {
    expect(isReservedHeader('Host')).toBe(true)
    expect(isReservedHeader('content-length')).toBe(true)
    expect(isReservedHeader('X-LancePay-Foo')).toBe(true)
    expect(isReservedHeader('Authorization')).toBe(false)
  })
})

describe('applyCustomHeaders', () => {
  it('merges custom headers but preserves reserved base headers', () => {
    const merged = applyCustomHeaders(
      {
        'content-type': 'application/json',
        'x-lancepay-signature': 'sig',
      },
      {
        'X-Tenant-Id': 'tenant-42',
        // attempting to override a reserved header should be ignored
        'X-LancePay-Signature': 'evil',
      },
    )
    expect(merged['x-lancepay-signature']).toBe('sig')
    expect(merged['X-Tenant-Id']).toBe('tenant-42')
    expect(merged['X-LancePay-Signature']).toBeUndefined()
  })
})

describe('POST /api/routes-b/webhooks with custom headers', () => {
  it('creates a webhook with valid headers and persists them', async () => {
    mockedWebhookCount.mockResolvedValue(0)
    mockedWebhookCreate.mockResolvedValue({
      id: 'wh-1',
      targetUrl: 'https://example.test/webhook',
      description: null,
      createdAt: new Date('2026-04-29T00:00:00Z'),
    } as never)

    const { POST } = await import('../route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({
        targetUrl: 'https://example.test/webhook',
        headers: { 'X-Tenant-Id': 'tenant-42' },
      }),
    })

    const res = await POST(request)
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.headers).toEqual({ 'X-Tenant-Id': 'tenant-42' })
    expect(getCustomHeaders('wh-1')).toEqual({ 'X-Tenant-Id': 'tenant-42' })
  })

  it('rejects creation when a reserved header is supplied', async () => {
    mockedWebhookCount.mockResolvedValue(0)

    const { POST } = await import('../route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({
        targetUrl: 'https://example.test/webhook',
        headers: { Host: 'attacker.test' },
      }),
    })

    const res = await POST(request)
    expect(res.status).toBe(400)
    expect(mockedWebhookCreate).not.toHaveBeenCalled()
  })

  it('rejects creation when a header value is too long', async () => {
    mockedWebhookCount.mockResolvedValue(0)

    const { POST } = await import('../route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({
        targetUrl: 'https://example.test/webhook',
        headers: { 'X-Big': 'a'.repeat(257) },
      }),
    })

    const res = await POST(request)
    expect(res.status).toBe(400)
    expect(mockedWebhookCreate).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/routes-b/webhooks/[id] with custom headers', () => {
  beforeEach(() => {
    mockedWebhookFindUnique.mockResolvedValue({
      id: 'wh-1',
      userId: 'user-1',
      targetUrl: 'https://example.test/webhook',
      description: null,
      subscribedEvents: ['invoice.paid'],
      isActive: true,
      signingSecret: 's'.repeat(64),
      createdAt: new Date('2026-04-29T00:00:00Z'),
      updatedAt: new Date('2026-04-29T00:00:00Z'),
    } as never)
    mockedWebhookUpdate.mockResolvedValue({
      id: 'wh-1',
      targetUrl: 'https://example.test/webhook',
      description: null,
      subscribedEvents: ['invoice.paid'],
      isActive: true,
      createdAt: new Date('2026-04-29T00:00:00Z'),
      updatedAt: new Date('2026-04-29T00:00:00Z'),
    } as never)
  })

  it('updates headers without other fields', async () => {
    const { PATCH } = await import('../[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks/wh-1', {
      method: 'PATCH',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ headers: { 'X-Tenant-Id': 'new-tenant' } }),
    })

    const res = await PATCH(request, { params: Promise.resolve({ id: 'wh-1' }) })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.webhook.headers).toEqual({ 'X-Tenant-Id': 'new-tenant' })
    expect(getCustomHeaders('wh-1')).toEqual({ 'X-Tenant-Id': 'new-tenant' })
  })

  it('clears headers when null is supplied', async () => {
    setCustomHeaders('wh-1', { 'X-Tenant-Id': 'old-tenant' })
    const { PATCH } = await import('../[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks/wh-1', {
      method: 'PATCH',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ headers: null }),
    })

    const res = await PATCH(request, { params: Promise.resolve({ id: 'wh-1' }) })
    expect(res.status).toBe(200)
    expect(getCustomHeaders('wh-1')).toEqual({})
  })

  it('rejects update with reserved header', async () => {
    const { PATCH } = await import('../[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks/wh-1', {
      method: 'PATCH',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ headers: { 'X-LancePay-Replay': 'attacker' } }),
    })

    const res = await PATCH(request, { params: Promise.resolve({ id: 'wh-1' }) })
    expect(res.status).toBe(400)
  })
})

describe('dispatchWebhookDelivery applies custom headers', () => {
  it('attaches stored custom headers without overriding reserved ones', async () => {
    setCustomHeaders('wh-1', {
      'X-Tenant-Id': 'tenant-42',
      Authorization: 'Bearer downstream',
    })

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchSpy)
    mockedDeliveryCreate.mockResolvedValue({} as never)
    vi.mocked(prisma.userWebhook.update).mockResolvedValue({} as never)

    const { dispatchWebhookDelivery } = await import('../../_lib/webhook-delivery')

    const result = await dispatchWebhookDelivery(
      { id: 'wh-1', targetUrl: 'https://example.test/webhook', signingSecret: 's'.repeat(64) },
      'invoice.paid',
      { id: 'evt_1', amount: 100 },
    )

    expect(result.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledOnce()
    const sentHeaders = (fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }).headers
    expect(sentHeaders['X-Tenant-Id']).toBe('tenant-42')
    expect(sentHeaders['Authorization']).toBe('Bearer downstream')
    expect(sentHeaders['x-lancepay-signature']).toBeDefined()
    expect(sentHeaders['x-lancepay-timestamp']).toBeDefined()
    expect(sentHeaders['content-type']).toBe('application/json')

    vi.unstubAllGlobals()
  })
})

describe('DELETE /api/routes-b/webhooks/[id] clears custom headers', () => {
  it('removes the headers entry on delete', async () => {
    setCustomHeaders('wh-1', { 'X-Tenant-Id': 'tenant-42' })
    expect(getCustomHeaders('wh-1')).toEqual({ 'X-Tenant-Id': 'tenant-42' })

    mockedWebhookFindUnique.mockResolvedValue({
      id: 'wh-1',
      userId: 'user-1',
    } as never)
    mockedWebhookDelete.mockResolvedValue({} as never)

    const { DELETE } = await import('../[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks/wh-1', {
      method: 'DELETE',
      headers: { authorization: 'Bearer token' },
    })

    const res = await DELETE(request, { params: Promise.resolve({ id: 'wh-1' }) })
    expect(res.status).toBe(204)
    expect(getCustomHeaders('wh-1')).toEqual({})
  })
})
