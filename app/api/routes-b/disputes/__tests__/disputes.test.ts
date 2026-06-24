import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('../../_lib/authz', () => ({
  requireScope: vi.fn(),
  RoutesBForbiddenError: class RoutesBForbiddenError extends Error {
    code = 'FORBIDDEN'
    status = 403
  },
}))
vi.mock('@/lib/db', () => ({
  prisma: {
    dispute: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    invoice: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}))

import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import { prisma } from '@/lib/db'
import { GET, POST } from '../route'

const mockedRequireScope = vi.mocked(requireScope)
const disputeDelegate = prisma.dispute as unknown as {
  findMany: ReturnType<typeof vi.fn>
  findUnique: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}
const invoiceDelegate = prisma.invoice as unknown as { findFirst: ReturnType<typeof vi.fn> }
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-b/disputes'
const AUTH = { userId: 'user-1', role: 'freelancer', scopes: ['routes-b:read'] }

function makeGet(authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function makePost(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-b/disputes', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedRequireScope.mockRejectedValue(new RoutesBForbiddenError('missing'))
    const res = await GET(makeGet(null))
    expect(res.status).toBe(401)
  })

  it('returns an empty list when the user has no disputes', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    disputeDelegate.findMany.mockResolvedValue([])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disputes).toEqual([])
  })

  it('returns the user disputes in descending createdAt order', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const row = {
      id: 'd-1',
      invoiceId: 'inv-1',
      reason: 'wrong amount',
      requestedAction: 'refund',
      status: 'open',
      resolution: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      resolvedAt: null,
    }
    disputeDelegate.findMany.mockResolvedValue([row])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disputes).toHaveLength(1)
    expect(body.disputes[0]).toMatchObject({ id: 'd-1', status: 'open' })
    expect(disputeDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { invoice: { userId: 'user-1' } } }),
    )
  })
})

describe('POST /api/routes-b/disputes', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedRequireScope.mockRejectedValue(new RoutesBForbiddenError('missing'))
    const res = await POST(makePost({ invoiceId: crypto.randomUUID(), reason: 'r', requestedAction: 'a' }, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 for missing required fields', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const res = await POST(makePost({ reason: 'wrong amount' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('returns 400 for invalid invoiceId (not a UUID)', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const res = await POST(makePost({ invoiceId: 'not-a-uuid', reason: 'r', requestedAction: 'a' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when the invoice does not belong to the user', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    invoiceDelegate.findFirst.mockResolvedValue(null)
    const res = await POST(makePost({ invoiceId: crypto.randomUUID(), reason: 'r', requestedAction: 'a' }))
    expect(res.status).toBe(404)
  })

  it('returns 409 when a dispute already exists for the invoice', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    invoiceDelegate.findFirst.mockResolvedValue({ id: 'inv-1', clientEmail: 'c@example.com' })
    disputeDelegate.findUnique.mockResolvedValue({ id: 'd-existing' })
    const res = await POST(makePost({ invoiceId: crypto.randomUUID(), reason: 'r', requestedAction: 'a' }))
    expect(res.status).toBe(409)
  })

  it('creates a dispute and returns 201', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const invId = crypto.randomUUID()
    invoiceDelegate.findFirst.mockResolvedValue({ id: invId, clientEmail: 'c@example.com' })
    disputeDelegate.findUnique.mockResolvedValue(null)
    userDelegate.findUnique.mockResolvedValue({ email: 'me@example.com' })
    disputeDelegate.create.mockResolvedValue({
      id: 'd-new',
      invoiceId: invId,
      reason: 'wrong amount',
      requestedAction: 'refund',
      status: 'open',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })
    const res = await POST(makePost({ invoiceId: invId, reason: 'wrong amount', requestedAction: 'refund' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.dispute).toMatchObject({ id: 'd-new', status: 'open' })
    expect(disputeDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: invId,
          initiatedBy: 'user-1',
          reason: 'wrong amount',
          requestedAction: 'refund',
        }),
      }),
    )
  })
})
