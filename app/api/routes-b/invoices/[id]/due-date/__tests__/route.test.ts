import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('../../../../_lib/events', () => ({ emitStatsInvalidated: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { emitStatsInvalidated } from '../../../../_lib/events'
import { PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockedInvoiceUpdate = vi.mocked(prisma.invoice.update)
const mockedEmitStatsInvalidated = vi.mocked(emitStatsInvalidated)

const invoiceId = '550e8400-e29b-41d4-a716-446655440000'
const userId = 'user-1'

function makePATCH(body: unknown, id = invoiceId, auth = true): NextRequest {
  return new NextRequest(`http://localhost/api/routes-b/invoices/${id}/due-date`, {
    method: 'PATCH',
    headers: auth ? { authorization: 'Bearer token' } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function makeParams(id = invoiceId) {
  return { params: Promise.resolve({ id }) }
}

describe('PATCH /api/routes-b/invoices/[id]/due-date', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: userId } as never)
    mockedInvoiceFind.mockResolvedValue({
      id: invoiceId,
      userId,
      status: 'pending',
    } as never)
    mockedInvoiceUpdate.mockResolvedValue({
      id: invoiceId,
      invoiceNumber: 'INV-001',
      dueDate: new Date('2099-01-15T00:00:00.000Z'),
    } as never)
  })

  it('updates an owned pending invoice due date', async () => {
    const res = await PATCH(
      makePATCH({ dueDate: '2099-01-15T00:00:00.000Z' }),
      makeParams(),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoice).toEqual({
      id: invoiceId,
      invoiceNumber: 'INV-001',
      dueDate: '2099-01-15T00:00:00.000Z',
    })
    expect(mockedInvoiceUpdate).toHaveBeenCalledWith({
      where: { id: invoiceId },
      data: { dueDate: new Date('2099-01-15T00:00:00.000Z') },
      select: {
        id: true,
        invoiceNumber: true,
        dueDate: true,
      },
    })
    expect(mockedEmitStatsInvalidated).toHaveBeenCalledWith({ userId })
  })

  it('clears the due date when dueDate is null', async () => {
    mockedInvoiceUpdate.mockResolvedValue({
      id: invoiceId,
      invoiceNumber: 'INV-001',
      dueDate: null,
    } as never)

    const res = await PATCH(makePATCH({ dueDate: null }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoice.dueDate).toBeNull()
    expect(mockedInvoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { dueDate: null },
      }),
    )
  })

  it('returns 401 when authorization is missing', async () => {
    const res = await PATCH(makePATCH({ dueDate: null }, invoiceId, false), makeParams())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 401 when token verification fails', async () => {
    mockedVerify.mockResolvedValue(null as never)

    const res = await PATCH(makePATCH({ dueDate: null }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-UUID invoice id', async () => {
    const res = await PATCH(makePATCH({ dueDate: null }, 'not-a-uuid'), makeParams('not-a-uuid'))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields.id).toBe('Must be a valid UUID')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 404 when the user cannot be resolved', async () => {
    mockedUserFind.mockResolvedValue(null)

    const res = await PATCH(makePATCH({ dueDate: null }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('User not found')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist', async () => {
    mockedInvoiceFind.mockResolvedValue(null)

    const res = await PATCH(makePATCH({ dueDate: null }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Invoice not found')
    expect(mockedInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({
      id: invoiceId,
      userId: 'other-user',
      status: 'pending',
    } as never)

    const res = await PATCH(makePATCH({ dueDate: null }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(mockedInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 422 when the invoice is not pending', async () => {
    mockedInvoiceFind.mockResolvedValue({
      id: invoiceId,
      userId,
      status: 'paid',
    } as never)

    const res = await PATCH(makePATCH({ dueDate: null }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.message).toBe('Due date can only be updated on pending invoices')
    expect(mockedInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 when JSON is malformed', async () => {
    const res = await PATCH(makePATCH('{'), makeParams())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.message).toBe('Invalid JSON body')
    expect(mockedInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 when dueDate is missing', async () => {
    const res = await PATCH(makePATCH({}), makeParams())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields.dueDate).toBe('Must be an ISO date string or null')
    expect(mockedInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 when dueDate is not a string or null', async () => {
    const res = await PATCH(makePATCH({ dueDate: 123 }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields.dueDate).toBe('Must be an ISO date string or null')
    expect(mockedInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 when dueDate is invalid', async () => {
    const res = await PATCH(makePATCH({ dueDate: 'not-a-date' }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields.dueDate).toBe('Must be a valid ISO date string')
    expect(mockedInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 when dueDate is in the past', async () => {
    const res = await PATCH(makePATCH({ dueDate: '2000-01-01T00:00:00.000Z' }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields.dueDate).toBe('Due date cannot be in the past')
    expect(mockedInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 500 when the update fails', async () => {
    mockedInvoiceUpdate.mockRejectedValue(new Error('db down'))

    const res = await PATCH(makePATCH({ dueDate: null }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error.code).toBe('INTERNAL')
    expect(body.error.message).toBe('Failed to update invoice due date')
  })
})
