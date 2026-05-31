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
import { PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockedInvoiceUpdate = vi.mocked(prisma.invoice.update)

const INVOICE_ID = 'inv-abc'
const USER_ID = 'user-1'

const fakeInvoice = {
  id: INVOICE_ID,
  userId: USER_ID,
  status: 'pending',
}

const fakeUpdated = {
  id: INVOICE_ID,
  invoiceNumber: 'INV-001',
  amount: 750,
  currency: 'USD',
  updatedAt: new Date(),
}

function makePatch(body: unknown, auth = 'Bearer token'): NextRequest {
  return new NextRequest(
    `http://localhost/api/routes-d/invoices/${INVOICE_ID}/amount`,
    {
      method: 'PATCH',
      headers: {
        ...(auth ? { authorization: auth } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
}

const params = Promise.resolve({ id: INVOICE_ID })

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: USER_ID } as never)
  mockedInvoiceFind.mockResolvedValue(fakeInvoice as never)
  mockedInvoiceUpdate.mockResolvedValue(fakeUpdated as never)
})

describe('PATCH /api/routes-d/invoices/[id]/amount', () => {
  it('returns 401 without authorization header', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await PATCH(makePatch({ amount: 500 }, ''), { params })
    expect(res.status).toBe(401)
  })

  it('returns 401 with invalid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await PATCH(makePatch({ amount: 500 }, 'Bearer bad'), { params })
    expect(res.status).toBe(401)
  })

  it('returns 401 when user cannot be resolved', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    const res = await PATCH(makePatch({ amount: 500 }), { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice does not exist', async () => {
    mockedInvoiceFind.mockResolvedValue(null as never)
    const res = await PATCH(makePatch({ amount: 500 }), { params })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Invoice not found')
  })

  it('returns 403 when invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...fakeInvoice, userId: 'other-user' } as never)
    const res = await PATCH(makePatch({ amount: 500 }), { params })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toBe('Forbidden')
  })

  it('returns 422 for a paid invoice', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...fakeInvoice, status: 'paid' } as never)
    const res = await PATCH(makePatch({ amount: 500 }), { params })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toMatch(/pending/i)
  })

  it('returns 422 for a cancelled invoice', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...fakeInvoice, status: 'cancelled' } as never)
    const res = await PATCH(makePatch({ amount: 500 }), { params })
    expect(res.status).toBe(422)
  })

  it('returns 400 when amount field is missing', async () => {
    const res = await PATCH(makePatch({}), { params })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/amount is required/i)
  })

  it('returns 400 for a zero amount', async () => {
    const res = await PATCH(makePatch({ amount: 0 }), { params })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/positive/i)
  })

  it('returns 400 for a negative amount', async () => {
    const res = await PATCH(makePatch({ amount: -100 }), { params })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/positive/i)
  })

  it('returns 400 for a non-numeric amount', async () => {
    const res = await PATCH(makePatch({ amount: 'abc' }), { params })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/positive/i)
  })

  it('returns 400 for NaN amount', async () => {
    const res = await PATCH(makePatch({ amount: NaN }), { params })
    expect(res.status).toBe(400)
  })

  it('updates the invoice amount and returns the updated invoice', async () => {
    const res = await PATCH(makePatch({ amount: 750 }), { params })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe(INVOICE_ID)
    expect(json.amount).toBe(750)
    expect(mockedInvoiceUpdate).toHaveBeenCalledWith({
      where: { id: INVOICE_ID },
      data: { amount: 750 },
      select: expect.any(Object),
    })
  })

  it('amount is serialized as a number in the response', async () => {
    const res = await PATCH(makePatch({ amount: 750 }), { params })
    const json = await res.json()
    expect(typeof json.amount).toBe('number')
  })
})