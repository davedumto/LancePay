import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindUnique = vi.fn()
const invoiceUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findUnique: invoiceFindUnique, update: invoiceUpdate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/invoices/inv-123/client'

function makeRequest(method: string, body?: unknown) {
  return new NextRequest(BASE_URL, {
    method,
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('GET /api/routes-b/invoices/[id]/client', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/invoices/[id]/client/route')
    const res = await GET(makeRequest('GET'), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/invoices/[id]/client/route')
    const res = await GET(makeRequest('GET'), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'User not found' })
  })

  it('returns 404 when invoice is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/invoices/[id]/client/route')
    const res = await GET(makeRequest('GET'), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Invoice not found' })
  })

  it('returns 403 when invoice belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_2', clientName: 'Alice', clientEmail: 'alice@example.com' })
    const { GET } = await import('@/app/api/routes-b/invoices/[id]/client/route')
    const res = await GET(makeRequest('GET'), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'Forbidden' })
  })

  it('returns 200 with client details for authorized user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_1', clientName: 'Alice', clientEmail: 'alice@example.com' })
    const { GET } = await import('@/app/api/routes-b/invoices/[id]/client/route')
    const res = await GET(makeRequest('GET'), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      id: 'inv-123',
      clientName: 'Alice',
      clientEmail: 'alice@example.com',
    })
  })
})

describe('PATCH /api/routes-b/invoices/[id]/client', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/client/route')
    const res = await PATCH(makeRequest('PATCH', { clientName: 'Bob' }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(401)
  })

  it('returns 422 if invoice is not pending', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_1', status: 'paid' })
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/client/route')
    const res = await PATCH(makeRequest('PATCH', { clientName: 'Bob' }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(422)
    await expect(res.json()).resolves.toEqual({ error: 'Only pending invoices can be edited' })
  })

  it('returns 400 for invalid clientEmail', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_1', status: 'pending' })
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/client/route')
    const res = await PATCH(makeRequest('PATCH', { clientEmail: 'invalid-email' }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'clientEmail must be a valid email address' })
  })

  it('updates client details successfully', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_1', status: 'pending' })
    invoiceUpdate.mockResolvedValue({ id: 'inv-123', clientName: 'Bob Smith', clientEmail: 'bob@example.com', updatedAt: '2026-08-25T10:00:00.000Z' })
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/client/route')
    const res = await PATCH(makeRequest('PATCH', { clientName: 'Bob Smith', clientEmail: 'bob@example.com' }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(200)
    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv-123' },
      data: { clientName: 'Bob Smith', clientEmail: 'bob@example.com' },
      select: { id: true, clientName: true, clientEmail: true, updatedAt: true },
    })
  })
})
