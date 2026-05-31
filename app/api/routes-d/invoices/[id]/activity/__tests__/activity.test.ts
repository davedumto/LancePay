import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    auditEvent: { findMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockedAuditFindMany = vi.mocked(prisma.auditEvent.findMany)

const INVOICE_ID = 'inv-1'
const USER_ID = 'user-1'

const fakeInvoice = { id: INVOICE_ID, userId: USER_ID }

const fakeEvents = [
  {
    id: 'evt-1',
    eventType: 'invoice.created',
    invoiceId: INVOICE_ID,
    actorId: USER_ID,
    metadata: { note: 'initial' },
    signature: 'sig',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: 'evt-2',
    eventType: 'invoice.viewed',
    invoiceId: INVOICE_ID,
    actorId: USER_ID,
    metadata: null,
    signature: 'sig2',
    createdAt: new Date('2026-01-02T00:00:00Z'),
  },
]

function makeRequest(auth = 'Bearer token'): NextRequest {
  return new NextRequest(`http://localhost/api/routes-d/invoices/${INVOICE_ID}/activity`, {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

const params = { params: Promise.resolve({ id: INVOICE_ID }) }

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: USER_ID } as never)
  mockedInvoiceFind.mockResolvedValue(fakeInvoice as never)
  mockedAuditFindMany.mockResolvedValue(fakeEvents as never)
})

describe('GET /api/routes-d/invoices/[id]/activity', () => {
  it('returns 401 when no bearer token is supplied', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(makeRequest(''), params)).status).toBe(401)
  })

  it('returns 401 when token does not verify', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(makeRequest(), params)).status).toBe(401)
  })

  it('returns 404 when user cannot be resolved from claims', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(makeRequest(), params)).status).toBe(404)
  })

  it('returns 404 when invoice does not exist', async () => {
    mockedInvoiceFind.mockResolvedValue(null as never)
    expect((await GET(makeRequest(), params)).status).toBe(404)
  })

  it('returns 403 when invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...fakeInvoice, userId: 'other-user' } as never)
    expect((await GET(makeRequest(), params)).status).toBe(403)
  })

  it('returns 200 with empty activity array when no events exist', async () => {
    mockedAuditFindMany.mockResolvedValue([] as never)
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.activity).toEqual([])
  })

  it('returns mapped activity events in ascending order', async () => {
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.activity).toHaveLength(2)
    expect(body.activity[0]).toMatchObject({
      id: 'evt-1',
      action: 'invoice.created',
      resourceType: 'invoice',
      resourceId: INVOICE_ID,
    })
    expect(body.activity[1]).toMatchObject({
      id: 'evt-2',
      action: 'invoice.viewed',
    })
  })

  it('queries auditEvent with invoiceId filter and asc order', async () => {
    await GET(makeRequest(), params)
    expect(mockedAuditFindMany).toHaveBeenCalledWith({
      where: { invoiceId: INVOICE_ID },
      orderBy: { createdAt: 'asc' },
    })
  })
})
