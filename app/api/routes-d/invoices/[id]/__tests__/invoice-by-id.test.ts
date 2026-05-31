import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockedInvoiceUpdate = vi.mocked(prisma.invoice.update)

const INVOICE_ID = 'inv-abc'
const USER_ID = 'user-1'

const fakeInvoice = {
  id: INVOICE_ID,
  userId: USER_ID,
  invoiceNumber: 'INV-001',
  clientEmail: 'client@example.com',
  clientName: 'Alice',
  description: 'Design work',
  amount: 200,
  currency: 'USD',
  status: 'pending',
  paymentLink: 'https://app/pay/INV-001',
  dueDate: null,
  paidAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

function makeRequest(
  method: string,
  body?: unknown,
  auth = 'Bearer token',
): NextRequest {
  return new NextRequest(`http://localhost/api/routes-d/invoices/${INVOICE_ID}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

const params = Promise.resolve({ id: INVOICE_ID })

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: USER_ID } as never)
  mockedInvoiceFind.mockResolvedValue(fakeInvoice as never)
})

/* ──────────────── GET ──────────────── */

describe('GET /api/routes-d/invoices/[id]', () => {
  it('returns 401 without token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(makeRequest('GET'), { params })).status).toBe(401)
  })

  it('returns 404 when invoice not found', async () => {
    mockedInvoiceFind.mockResolvedValue(null as never)
    expect((await GET(makeRequest('GET'), { params })).status).toBe(404)
  })

  it('returns 403 when invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...fakeInvoice, userId: 'other-user' } as never)
    expect((await GET(makeRequest('GET'), { params })).status).toBe(403)
  })

  it('returns the invoice for the owner', async () => {
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.invoice.id).toBe(INVOICE_ID)
    expect(json.invoice.amount).toBe(200)
  })
})

/* ──────────────── PATCH ──────────────── */

describe('PATCH /api/routes-d/invoices/[id]', () => {
  it('returns 401 without token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await PATCH(makeRequest('PATCH', {}), { params })).status).toBe(401)
  })

  it('returns 404 when invoice not found', async () => {
    mockedInvoiceFind.mockResolvedValue(null as never)
    expect((await PATCH(makeRequest('PATCH', { description: 'X' }), { params })).status).toBe(404)
  })

  it('returns 403 when invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...fakeInvoice, userId: 'other-user' } as never)
    expect((await PATCH(makeRequest('PATCH', { description: 'X' }), { params })).status).toBe(403)
  })

  it('returns 422 when invoice is not pending', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...fakeInvoice, status: 'paid' } as never)
    expect((await PATCH(makeRequest('PATCH', { description: 'X' }), { params })).status).toBe(422)
  })

  it('returns 400 for empty description', async () => {
    expect((await PATCH(makeRequest('PATCH', { description: '' }), { params })).status).toBe(400)
  })

  it('returns 400 for non-positive amount', async () => {
    expect((await PATCH(makeRequest('PATCH', { amount: 0 }), { params })).status).toBe(400)
  })

  it('returns 400 for invalid dueDate', async () => {
    expect(
      (await PATCH(makeRequest('PATCH', { dueDate: 'not-a-date' }), { params })).status,
    ).toBe(400)
  })

  it('returns 400 when no valid fields are provided', async () => {
    expect((await PATCH(makeRequest('PATCH', {}), { params })).status).toBe(400)
  })

  it('updates and returns the invoice', async () => {
    const updated = { ...fakeInvoice, description: 'Updated work', amount: 300 }
    mockedInvoiceUpdate.mockResolvedValue(updated as never)

    const res = await PATCH(
      makeRequest('PATCH', { description: 'Updated work', amount: 300 }),
      { params },
    )
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.invoice.description).toBe('Updated work')
    expect(json.invoice.amount).toBe(300)
  })

  it('allows clearing dueDate with null', async () => {
    const updated = { ...fakeInvoice, dueDate: null }
    mockedInvoiceUpdate.mockResolvedValue(updated as never)

    const res = await PATCH(makeRequest('PATCH', { dueDate: null }), { params })
    expect(res.status).toBe(200)
    expect(mockedInvoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dueDate: null }) }),
    )
  })
})
