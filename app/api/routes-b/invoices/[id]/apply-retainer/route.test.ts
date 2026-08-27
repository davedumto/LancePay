import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindFirst = vi.fn()
const subscriptionFindFirst = vi.fn()
const invoiceUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findFirst: invoiceFindFirst, update: invoiceUpdate },
    subscription: { findFirst: subscriptionFindFirst },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/invoices/inv-1/apply-retainer'

function req(body?: unknown, token: string | null = 'tok') {
  const h = new Headers()
  if (token) h.set('authorization', `Bearer ${token}`)
  h.set('content-type', 'application/json')
  return new NextRequest(URL, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body ?? {}),
  })
}

const ctx = { params: Promise.resolve({ id: 'inv-1' }) }

describe('POST /api/routes-b/invoices/[id]/apply-retainer (#1115)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    const { POST } = await import('./route')
    const res = await POST(req({}, null), ctx)
    expect(res.status).toBe(401)
  })

  it('returns 400 when subscriptionId is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    const { POST } = await import('./route')
    const res = await POST(req({}), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/subscriptionId/)
  })

  it('returns 404 when invoice not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue(null)
    const { POST } = await import('./route')
    const res = await POST(req({ subscriptionId: 'sub-1' }), ctx)
    expect(res.status).toBe(404)
  })

  it('returns 422 when invoice is paid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-1', amount: 500, currency: 'USD', status: 'paid',
      clientEmail: 'client@example.com', subscriptionId: null,
    })
    const { POST } = await import('./route')
    const res = await POST(req({ subscriptionId: 'sub-1' }), ctx)
    expect(res.status).toBe(422)
  })

  it('returns 409 when retainer already applied', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-1', amount: 500, currency: 'USD', status: 'pending',
      clientEmail: 'client@example.com', subscriptionId: 'sub-existing',
    })
    const { POST } = await import('./route')
    const res = await POST(req({ subscriptionId: 'sub-1' }), ctx)
    expect(res.status).toBe(409)
  })

  it('returns 422 when client email does not match', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-1', amount: 500, currency: 'USD', status: 'pending',
      clientEmail: 'client@example.com', subscriptionId: null,
    })
    subscriptionFindFirst.mockResolvedValue({
      id: 'sub-1', userId: 'user-1', status: 'active',
      clientEmail: 'other@example.com', amount: 200,
    })
    const { POST } = await import('./route')
    const res = await POST(req({ subscriptionId: 'sub-1' }), ctx)
    expect(res.status).toBe(422)
  })

  it('applies retainer credit successfully', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-1', amount: 500, currency: 'USD', status: 'pending',
      clientEmail: 'client@example.com', subscriptionId: null,
    })
    subscriptionFindFirst.mockResolvedValue({
      id: 'sub-1', userId: 'user-1', status: 'active',
      clientEmail: 'client@example.com', amount: 200,
    })
    invoiceUpdate.mockResolvedValue({
      id: 'inv-1', amount: 300, currency: 'USD', status: 'pending', subscriptionId: 'sub-1',
    })

    const { POST } = await import('./route')
    const res = await POST(req({ subscriptionId: 'sub-1' }), ctx)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.creditApplied).toBe(200)
    expect(json.newAmount).toBe(300)
    expect(json.subscriptionId).toBe('sub-1')
  })
})
