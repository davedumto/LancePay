/**
 * Invoice lifecycle integration tests.
 *
 * Exercises the create → update → status-transition flow end-to-end across
 * the individual route handlers, with Prisma mocked at the boundary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  generateInvoiceNumber: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { prisma } from '@/lib/db'
import { POST, GET } from '../route'
import { GET as GETById, PATCH as PATCHById } from '../[id]/route'
import { POST as CancelInvoice } from '../[id]/cancel/route'

const mockVerify = vi.mocked(verifyAuthToken)
const mockGenerateNumber = vi.mocked(generateInvoiceNumber)
const mockUserFind = vi.mocked(prisma.user.findUnique)
const mockInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockInvoiceFindFirst = vi.mocked(prisma.invoice.findFirst)
const mockInvoiceCreate = vi.mocked(prisma.invoice.create)
const mockInvoiceUpdate = vi.mocked(prisma.invoice.update)

const fakeUser = { id: 'user-1', privyId: 'privy-1', role: 'freelancer' }

const baseInvoice = {
  id: 'inv-1',
  userId: 'user-1',
  invoiceNumber: 'INV-001',
  clientEmail: 'client@example.com',
  clientName: 'ACME Corp',
  description: 'Web development services',
  amount: '500.00',
  currency: 'USD',
  status: 'pending',
  paymentLink: 'https://app.example.com/pay/INV-001',
  dueDate: null,
  paidAt: null,
  createdAt: new Date('2025-06-01T00:00:00Z'),
  updatedAt: new Date('2025-06-01T00:00:00Z'),
  cancelledAt: null,
  cancellationReason: null,
}

function makeReq(method: string, url: string, body?: object, auth = true): NextRequest {
  return new NextRequest(url, {
    method,
    headers: auth ? { authorization: 'Bearer tok' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

function makeParamsCtx(id: string) {
  return { params: Promise.resolve({ id }) }
}

describe('Invoice lifecycle — create', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockUserFind.mockResolvedValue(fakeUser as never)
    mockGenerateNumber.mockReturnValue('INV-001')
    mockInvoiceFind.mockResolvedValue(null as never) // no collision on invoiceNumber
    mockInvoiceFindFirst.mockResolvedValue(null as never) // no duplicate
    mockInvoiceCreate.mockResolvedValue(baseInvoice as never)
  })

  it('creates a pending invoice and returns 201 with required fields', async () => {
    const req = makeReq('POST', 'http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      clientName: 'ACME Corp',
      description: 'Web development services',
      amount: 500,
      currency: 'USD',
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.status).toBe('pending')
    expect(body.invoiceNumber).toBe('INV-001')
    expect(body.paymentLink).toContain('INV-001')
    expect(body.amount).toBe(500)
    expect(body.currency).toBe('USD')
  })

  it('returns 400 when required fields are missing', async () => {
    const req = makeReq('POST', 'http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      // missing description and amount
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(mockInvoiceCreate).not.toHaveBeenCalled()
  })

  it('returns 400 for non-positive amount', async () => {
    const req = makeReq('POST', 'http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      description: 'Test',
      amount: -50,
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 409 when a near-duplicate invoice exists', async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: 'inv-existing' } as never)

    const req = makeReq('POST', 'http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      description: 'Web development services',
      amount: 500,
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.duplicateOfId).toBe('inv-existing')
  })

  it('normalises clientEmail to lowercase on create', async () => {
    const req = makeReq('POST', 'http://localhost/api/routes-b/invoices', {
      clientEmail: 'Client@EXAMPLE.COM',
      description: 'Test',
      amount: 100,
    })

    await POST(req)

    expect(mockInvoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientEmail: 'client@example.com' }),
      }),
    )
  })
})

describe('Invoice lifecycle — read by ID', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockUserFind.mockResolvedValue(fakeUser as never)
  })

  it('returns invoice details for the owner', async () => {
    mockInvoiceFind.mockResolvedValue(baseInvoice as never)

    const req = makeReq('GET', 'http://localhost/api/routes-b/invoices/inv-1')
    const res = await GETById(req, makeParamsCtx('inv-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoice.id).toBe('inv-1')
    expect(body.invoice.status).toBe('pending')
    expect(typeof body.invoice.amount).toBe('number')
  })

  it('returns 404 when invoice does not exist', async () => {
    mockInvoiceFind.mockResolvedValue(null as never)

    const req = makeReq('GET', 'http://localhost/api/routes-b/invoices/nonexistent')
    const res = await GETById(req, makeParamsCtx('nonexistent'))

    expect(res.status).toBe(404)
  })

  it('returns 404 when invoice belongs to a different user (hides existence)', async () => {
    mockInvoiceFind.mockResolvedValue({ ...baseInvoice, userId: 'other-user' } as never)

    const req = makeReq('GET', 'http://localhost/api/routes-b/invoices/inv-1')
    const res = await GETById(req, makeParamsCtx('inv-1'))

    // checkResourceOwnership intentionally returns 404 to prevent existence leaks
    expect(res.status).toBe(404)
  })

  it('sets an ETag header on the response', async () => {
    mockInvoiceFind.mockResolvedValue(baseInvoice as never)

    const req = makeReq('GET', 'http://localhost/api/routes-b/invoices/inv-1')
    const res = await GETById(req, makeParamsCtx('inv-1'))

    expect(res.headers.get('etag')).toBeTruthy()
  })
})

describe('Invoice lifecycle — update (PATCH)', () => {
  function makeEtag(id: string, updatedAt: Date) {
    const hash = crypto
      .createHash('sha256')
      .update(`${id}:${updatedAt.toISOString()}`)
      .digest('hex')
    return `"${hash}"`
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockUserFind.mockResolvedValue(fakeUser as never)
    mockInvoiceFind.mockResolvedValue(baseInvoice as never)
  })

  it('updates description and amount on a pending invoice', async () => {
    const updated = { ...baseInvoice, description: 'Updated scope', amount: '750.00' }
    mockInvoiceUpdate.mockResolvedValue(updated as never)

    const correctEtag = makeEtag(baseInvoice.id, baseInvoice.updatedAt)
    const req = makeReq('PATCH', 'http://localhost/api/routes-b/invoices/inv-1', {
      description: 'Updated scope',
      amount: 750,
    })
    req.headers.set('if-match', correctEtag)

    const res = await PATCHById(req, makeParamsCtx('inv-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.description).toBe('Updated scope')
    expect(body.amount).toBe(750)
  })

  it('returns 412 when If-Match header is stale', async () => {
    const staleEtag = '"stale-etag-value"'
    const req = makeReq('PATCH', 'http://localhost/api/routes-b/invoices/inv-1', {
      description: 'New desc',
    })
    req.headers.set('if-match', staleEtag)

    const res = await PATCHById(req, makeParamsCtx('inv-1'))

    expect(res.status).toBe(412)
    expect(mockInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 422 when trying to update a non-pending invoice', async () => {
    mockInvoiceFind.mockResolvedValue({ ...baseInvoice, status: 'paid' } as never)

    const req = makeReq('PATCH', 'http://localhost/api/routes-b/invoices/inv-1', {
      description: 'New desc',
    })
    req.headers.set('if-match', makeEtag(baseInvoice.id, baseInvoice.updatedAt))

    const res = await PATCHById(req, makeParamsCtx('inv-1'))

    expect(res.status).toBe(422)
    expect(mockInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 428 when If-Match header is missing', async () => {
    const req = makeReq('PATCH', 'http://localhost/api/routes-b/invoices/inv-1', {
      description: 'New desc',
    })
    // No If-Match header

    const res = await PATCHById(req, makeParamsCtx('inv-1'))

    expect(res.status).toBe(428)
  })

  it('returns 400 for empty description string', async () => {
    const req = makeReq('PATCH', 'http://localhost/api/routes-b/invoices/inv-1', {
      description: '   ',
    })
    req.headers.set('if-match', '*')
    mockUserFind.mockResolvedValue({ ...fakeUser, role: 'admin' } as never)

    const res = await PATCHById(req, makeParamsCtx('inv-1'))

    expect(res.status).toBe(400)
  })
})

describe('Invoice lifecycle — cancellation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockUserFind.mockResolvedValue(fakeUser as never)
  })

  it('cancels a pending invoice and records cancelledAt', async () => {
    mockInvoiceFind.mockResolvedValue(baseInvoice as never)
    const cancelledAt = new Date()
    mockInvoiceUpdate.mockResolvedValue({
      ...baseInvoice,
      status: 'cancelled',
      cancelledAt,
    } as never)

    const req = makeReq('POST', 'http://localhost/api/routes-b/invoices/inv-1/cancel')
    const res = await CancelInvoice(req, makeParamsCtx('inv-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('cancelled')
    expect(body.cancelledAt).toBeDefined()
  })

  it('cancels with an optional reason', async () => {
    mockInvoiceFind.mockResolvedValue(baseInvoice as never)
    mockInvoiceUpdate.mockResolvedValue({
      ...baseInvoice,
      status: 'cancelled',
      cancelledAt: new Date(),
      cancellationReason: 'Client request',
    } as never)

    const req = makeReq(
      'POST',
      'http://localhost/api/routes-b/invoices/inv-1/cancel',
      { reason: 'Client request' },
    )
    const res = await CancelInvoice(req, makeParamsCtx('inv-1'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.cancellationReason).toBe('Client request')
    expect(mockInvoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cancellationReason: 'Client request' }),
      }),
    )
  })

  it('returns 422 when cancelling an already-cancelled invoice', async () => {
    mockInvoiceFind.mockResolvedValue({ ...baseInvoice, status: 'cancelled' } as never)

    const req = makeReq('POST', 'http://localhost/api/routes-b/invoices/inv-1/cancel')
    const res = await CancelInvoice(req, makeParamsCtx('inv-1'))

    expect(res.status).toBe(422)
  })

  it('returns 422 when cancelling a paid invoice', async () => {
    mockInvoiceFind.mockResolvedValue({
      ...baseInvoice,
      status: 'paid',
      paidAt: new Date(),
    } as never)

    const req = makeReq('POST', 'http://localhost/api/routes-b/invoices/inv-1/cancel')
    const res = await CancelInvoice(req, makeParamsCtx('inv-1'))

    expect(res.status).toBe(422)
  })

  it('returns 400 when reason exceeds 200 characters', async () => {
    mockInvoiceFind.mockResolvedValue(baseInvoice as never)

    const req = makeReq(
      'POST',
      'http://localhost/api/routes-b/invoices/inv-1/cancel',
      { reason: 'x'.repeat(201) },
    )
    const res = await CancelInvoice(req, makeParamsCtx('inv-1'))

    expect(res.status).toBe(400)
  })

  it('returns 404 when invoice does not exist', async () => {
    mockInvoiceFind.mockResolvedValue(null as never)

    const req = makeReq('POST', 'http://localhost/api/routes-b/invoices/nonexistent/cancel')
    const res = await CancelInvoice(req, makeParamsCtx('nonexistent'))

    expect(res.status).toBe(404)
  })
})

describe('Invoice lifecycle — list with status filters', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockUserFind.mockResolvedValue(fakeUser as never)
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([])
  })

  it('returns 400 for an invalid status filter', async () => {
    const req = makeReq('GET', 'http://localhost/api/routes-b/invoices?status=invalid')
    const res = await GET(req)

    expect(res.status).toBe(400)
  })

  it('accepts valid status filters without error', async () => {
    for (const status of ['pending', 'paid', 'overdue', 'cancelled']) {
      const req = makeReq('GET', `http://localhost/api/routes-b/invoices?status=${status}`)
      const res = await GET(req)
      expect(res.status).toBe(200)
    }
  })

  it('returns paginated results with nextCursor', async () => {
    const invoices = Array.from({ length: 26 }, (_, i) => ({
      ...baseInvoice,
      id: `inv-${i}`,
      invoiceNumber: `INV-${i}`,
      createdAt: new Date(Date.now() - i * 1000),
    }))
    vi.mocked(prisma.invoice.findMany).mockResolvedValue(invoices as never)

    const req = makeReq('GET', 'http://localhost/api/routes-b/invoices?limit=25')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(25)
    expect(body.nextCursor).not.toBeNull()
  })
})
