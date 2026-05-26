import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    auditEvent: { findMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../[id]/activity/route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFindUnique = vi.mocked(prisma.invoice.findUnique)
const mockedAuditFindMany = vi.mocked(prisma.auditEvent.findMany)

const fakeUser = { id: 'user-1', privyId: 'privy-1' }
const ownedInvoice = { id: 'inv-1', userId: 'user-1' }
const otherInvoice = { id: 'inv-1', userId: 'user-2' }

function makeRequest(authHeader = 'Bearer token'): NextRequest {
  return new NextRequest(
    'http://localhost/api/routes-b/invoices/inv-1/activity',
    {
      method: 'GET',
      headers: authHeader ? { authorization: authHeader } : {},
    },
  )
}

const params = { params: Promise.resolve({ id: 'inv-1' }) }

describe('GET /api/routes-b/invoices/[id]/activity', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 401 when the authorization token is missing or invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeRequest(''), params)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the invoice does not exist', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(fakeUser as never)
    mockedInvoiceFindUnique.mockResolvedValue(null as never)
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(404)
  })

  it('returns 403 when the invoice belongs to a different user', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(fakeUser as never)
    mockedInvoiceFindUnique.mockResolvedValue(otherInvoice as never)
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(403)
  })

  it('returns an empty activity array (not 404) when no audit events exist', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(fakeUser as never)
    mockedInvoiceFindUnique.mockResolvedValue(ownedInvoice as never)
    mockedAuditFindMany.mockResolvedValue([] as never)

    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.activity).toEqual([])
  })

  it('returns activity ordered ascending with mapped action and ipAddress fields', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(fakeUser as never)
    mockedInvoiceFindUnique.mockResolvedValue(ownedInvoice as never)
    const createdEarly = new Date('2025-01-01T00:00:00.000Z')
    const createdLate = new Date('2025-01-02T09:00:00.000Z')
    mockedAuditFindMany.mockResolvedValue([
      {
        id: 'evt-1',
        eventType: 'invoice_created',
        metadata: { ipAddress: '192.168.1.1' },
        createdAt: createdEarly,
      },
      {
        id: 'evt-2',
        eventType: 'invoice_viewed',
        metadata: null,
        createdAt: createdLate,
      },
    ] as never)

    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.activity).toHaveLength(2)
    expect(body.activity[0]).toMatchObject({
      id: 'evt-1',
      action: 'invoice_created',
      ipAddress: '192.168.1.1',
    })
    expect(body.activity[1]).toMatchObject({
      id: 'evt-2',
      action: 'invoice_viewed',
      ipAddress: null,
    })

    // Confirm the route asks Prisma for an ascending-by-createdAt query.
    expect(mockedAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { invoiceId: 'inv-1' },
        orderBy: { createdAt: 'asc' },
      }),
    )
  })
})
