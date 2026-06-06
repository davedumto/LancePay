import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/utils', () => ({ generateInvoiceNumber: vi.fn() }))
vi.mock('../../../../_lib/events', () => ({ emitStatsInvalidated: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { generateInvoiceNumber } from '@/lib/utils'
import { emitStatsInvalidated } from '../../../../_lib/events'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockedInvoiceCreate = vi.mocked(prisma.invoice.create)
const mockedGenerateInvoiceNumber = vi.mocked(generateInvoiceNumber)
const mockedEmitStatsInvalidated = vi.mocked(emitStatsInvalidated)

const invoiceId = '550e8400-e29b-41d4-a716-446655440000'
const userId = 'user-1'

const sourceInvoice = {
  id: invoiceId,
  userId,
  clientEmail: 'client@example.com',
  clientName: 'ACME Corp',
  description: 'Original work',
  amount: '500.00',
  currency: 'USD',
}

function makePOST(id = invoiceId, auth = true): NextRequest {
  return new NextRequest(`http://localhost/api/routes-b/invoices/${id}/duplicate`, {
    method: 'POST',
    headers: auth
      ? { authorization: 'Bearer token', host: 'localhost' }
      : { host: 'localhost' },
  })
}

function makeParams(id = invoiceId) {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/routes-b/invoices/[id]/duplicate', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: userId } as never)
    mockedInvoiceFind.mockResolvedValue(sourceInvoice as never)
    mockedGenerateInvoiceNumber.mockReturnValue('INV-COPY-001')
    mockedInvoiceCreate.mockResolvedValue({
      id: 'copy-1',
      invoiceNumber: 'INV-COPY-001',
      clientEmail: 'client@example.com',
      clientName: 'ACME Corp',
      description: 'Original work',
      amount: '500.00',
      currency: 'USD',
      status: 'pending',
      paymentLink: 'https://app.example/pay/INV-COPY-001',
      dueDate: null,
      paidAt: null,
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    } as never)
  })

  it('duplicates an owned invoice as a pending invoice', async () => {
    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.invoice).toEqual({
      id: 'copy-1',
      invoiceNumber: 'INV-COPY-001',
      clientEmail: 'client@example.com',
      clientName: 'ACME Corp',
      description: 'Original work',
      amount: 500,
      currency: 'USD',
      status: 'pending',
      paymentLink: 'https://app.example/pay/INV-COPY-001',
      dueDate: null,
      paidAt: null,
      createdAt: '2026-01-01T12:00:00.000Z',
    })
    expect(mockedInvoiceCreate).toHaveBeenCalledWith({
      data: {
        userId,
        invoiceNumber: 'INV-COPY-001',
        paymentLink: 'https://localhost/pay/INV-COPY-001',
        clientEmail: 'client@example.com',
        clientName: 'ACME Corp',
        description: 'Original work',
        amount: '500.00',
        currency: 'USD',
        status: 'pending',
        dueDate: null,
        paidAt: null,
        cancelledAt: null,
        cancellationReason: null,
      },
      select: {
        id: true,
        invoiceNumber: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        status: true,
        paymentLink: true,
        dueDate: true,
        paidAt: true,
        createdAt: true,
      },
    })
    expect(mockedEmitStatsInvalidated).toHaveBeenCalledWith({ userId })
  })

  it('returns 401 when authorization is missing', async () => {
    const res = await POST(makePOST(invoiceId, false), makeParams())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-UUID invoice id', async () => {
    const res = await POST(makePOST('not-a-uuid'), makeParams('not-a-uuid'))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields.id).toBe('Must be a valid UUID')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 404 when the user cannot be resolved', async () => {
    mockedUserFind.mockResolvedValue(null)

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('User not found')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 404 when the source invoice does not exist', async () => {
    mockedInvoiceFind.mockResolvedValue(null)

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Invoice not found')
    expect(mockedInvoiceCreate).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...sourceInvoice, userId: 'other-user' } as never)

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(mockedInvoiceCreate).not.toHaveBeenCalled()
  })

  it('returns 500 when duplication fails', async () => {
    mockedInvoiceCreate.mockRejectedValue(new Error('db down'))

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error.code).toBe('INTERNAL')
    expect(body.error.message).toBe('Failed to duplicate invoice')
  })
})
