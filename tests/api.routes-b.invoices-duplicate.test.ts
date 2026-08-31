import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindUnique = vi.fn()
const invoiceCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findUnique: invoiceFindUnique, create: invoiceCreate },
  },
}))
vi.mock('@/lib/utils', () => ({
  generateInvoiceNumber: () => 'INV-2026-DUP',
}))

const BASE_URL = 'http://localhost/api/routes-b/invoices/inv-123/duplicate'

function makeRequest(method: string, body?: unknown) {
  return new NextRequest(BASE_URL, {
    method,
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/routes-b/invoices/[id]/duplicate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/duplicate/route')
    const res = await POST(makeRequest('POST'), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when original invoice is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/duplicate/route')
    const res = await POST(makeRequest('POST'), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Original invoice not found' })
  })

  it('returns 403 when original invoice belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_2' })
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/duplicate/route')
    const res = await POST(makeRequest('POST'), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'Forbidden' })
  })

  it('successfully duplicates invoice and returns 201', async () => {
    const original = {
      id: 'inv-123',
      userId: 'user_1',
      clientEmail: 'client@example.com',
      clientName: 'Client Name',
      description: 'Design Work',
      amount: 500,
      currency: 'USD',
      status: 'paid',
    }
    const duplicated = {
      id: 'inv-dup-123',
      userId: 'user_1',
      invoiceNumber: 'INV-2026-DUP',
      paymentLink: 'http://localhost/pay/INV-2026-DUP',
      clientEmail: 'client@example.com',
      clientName: 'Client Name',
      description: 'Design Work',
      amount: 500,
      currency: 'USD',
      status: 'pending',
      dueDate: null,
      paidAt: null,
    }

    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue(original)
    invoiceCreate.mockResolvedValue(duplicated)

    const { POST } = await import('@/app/api/routes-b/invoices/[id]/duplicate/route')
    const res = await POST(makeRequest('POST'), { params: Promise.resolve({ id: 'inv-123' }) })

    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toEqual(duplicated)
    expect(invoiceCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user_1',
        invoiceNumber: 'INV-2026-DUP',
        paymentLink: expect.stringContaining('/pay/INV-2026-DUP'),
        clientEmail: 'client@example.com',
        clientName: 'Client Name',
        description: 'Design Work',
        amount: 500,
        currency: 'USD',
        status: 'pending',
        dueDate: null,
        paidAt: null,
      },
    })
  })
})
