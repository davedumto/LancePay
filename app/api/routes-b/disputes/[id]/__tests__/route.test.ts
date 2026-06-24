import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('../../../_lib/authz', () => ({
  requireScope: vi.fn(),
  RoutesBForbiddenError: class RoutesBForbiddenError extends Error {
    code = 'FORBIDDEN'
    status = 403
  },
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    dispute: { findUnique: vi.fn() },
  },
}))

import { requireScope, RoutesBForbiddenError } from '../../../_lib/authz'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedRequireScope = vi.mocked(requireScope)
const disputeDelegate = prisma.dispute as unknown as {
  findUnique: ReturnType<typeof vi.fn>
}

const BASE_URL = 'http://localhost/api/routes-b/disputes'
const AUTH = { userId: 'user-1', role: 'freelancer', scopes: ['routes-b:read'] }

function makeGet(id: string, authHeader: string | null = 'Bearer token') {
  return new NextRequest(`${BASE_URL}/${id}`, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('GET /api/routes-b/disputes/[id]', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedRequireScope.mockRejectedValue(new RoutesBForbiddenError('missing'))
    const id = crypto.randomUUID()
    const res = await GET(makeGet(id, null), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(401)
  })

  it('returns 400 when dispute ID is not a valid UUID', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const id = 'not-a-uuid'
    const res = await GET(makeGet(id), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('returns 404 when dispute is not found', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const id = crypto.randomUUID()
    disputeDelegate.findUnique.mockResolvedValue(null)
    const res = await GET(makeGet(id), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(404)
  })

  it('returns 404 when dispute belongs to another user', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const id = crypto.randomUUID()
    disputeDelegate.findUnique.mockResolvedValue({
      id,
      invoiceId: 'inv-1',
      invoice: { userId: 'user-2' }, // Belonging to user-2
    })
    const res = await GET(makeGet(id), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(404)
  })

  it('returns the dispute details when successful', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const id = crypto.randomUUID()
    const disputeRow = {
      id,
      invoiceId: 'inv-1',
      reason: 'wrong amount',
      requestedAction: 'refund',
      status: 'open',
      resolution: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      resolvedAt: null,
      invoice: { userId: 'user-1' }, // Belonging to user-1
    }
    disputeDelegate.findUnique.mockResolvedValue(disputeRow)
    const res = await GET(makeGet(id), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.dispute).toBeDefined()
    expect(body.dispute.id).toBe(id)
    expect(body.dispute.invoice).toBeUndefined() // invoice metadata excluded
  })
})
