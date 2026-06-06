import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedLoggerError = vi.mocked(logger.error)
const invoiceDelegate = prisma.invoice as unknown as { findUnique: ReturnType<typeof vi.fn> }

const URL = 'http://localhost/api/routes-d/invoices/inv-1/payment-status'

function makeRequest(authHeader: string | null = null) {
  return new NextRequest(URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function withParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

const invoice = {
  id: 'inv-1',
  invoiceNumber: 'INV-001',
  status: 'paid',
  amount: '250.00',
  currency: 'USD',
  paidAt: new Date('2026-02-01T00:00:00Z'),
  dueDate: new Date('2026-01-15T00:00:00Z'),
}

describe('GET /api/routes-d/invoices/[id]/payment-status', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 404 when no invoice matches the id or invoice number', async () => {
    invoiceDelegate.findUnique.mockResolvedValue(null)
    const res = await GET(makeRequest(), withParams('missing'))
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Invoice not found' })
  })

  it('returns the payment status looked up by id without requiring auth', async () => {
    invoiceDelegate.findUnique.mockResolvedValueOnce(invoice)
    const res = await GET(makeRequest(), withParams('inv-1'))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      invoiceNumber: 'INV-001',
      status: 'paid',
      amount: 250,
      currency: 'USD',
      paidAt: '2026-02-01T00:00:00.000Z',
      dueDate: '2026-01-15T00:00:00.000Z',
    })
    expect(mockedVerify).not.toHaveBeenCalled()
  })

  it('falls back to looking up the invoice by invoice number', async () => {
    invoiceDelegate.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(invoice)
    const res = await GET(makeRequest(), withParams('INV-001'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.invoiceNumber).toBe('INV-001')
    expect(invoiceDelegate.findUnique).toHaveBeenNthCalledWith(1, { where: { id: 'INV-001' } })
    expect(invoiceDelegate.findUnique).toHaveBeenNthCalledWith(2, {
      where: { invoiceNumber: 'INV-001' },
    })
  })

  it('verifies the token when an authorization header is present', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    invoiceDelegate.findUnique.mockResolvedValueOnce(invoice)
    const res = await GET(makeRequest('Bearer token'), withParams('inv-1'))
    expect(res.status).toBe(200)
    expect(mockedVerify).toHaveBeenCalledWith('token')
  })

  it('returns 500 and logs when the lookup throws', async () => {
    invoiceDelegate.findUnique.mockRejectedValue(new Error('db down'))
    const res = await GET(makeRequest(), withParams('inv-1'))
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'Failed to get payment status' })
    expect(mockedLoggerError).toHaveBeenCalled()
  })
})
