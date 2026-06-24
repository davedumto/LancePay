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
    reminderSettings: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}))

import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import { prisma } from '@/lib/db'
import { GET, POST } from '../route'

const mockedRequireScope = vi.mocked(requireScope)
const settingsDelegate = prisma.reminderSettings as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}

const BASE_URL = 'http://localhost/api/routes-b/late-fee-policies'
const AUTH = { userId: 'user-1', role: 'freelancer', scopes: ['routes-b:read'] }

function makeGet() {
  return new NextRequest(BASE_URL, { headers: { authorization: 'Bearer token' } })
}

function makePost(body: unknown) {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-b/late-fee-policies', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedRequireScope.mockRejectedValue(new RoutesBForbiddenError('missing'))
    const res = await GET(makeGet())
    expect(res.status).toBe(401)
  })

  it('returns the default policy when no custom message is set', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    settingsDelegate.findUnique.mockResolvedValue(null)
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.policy).toMatchObject({ ratePerPeriod: 0.015, periodDays: 30, capFraction: 0.1 })
  })

  it('returns a stored policy', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    settingsDelegate.findUnique.mockResolvedValue({
      id: 'rs-1',
      customMessage: JSON.stringify({ routesBLateFeePolicy: { ratePerPeriod: 0.02, periodDays: 14, capFraction: 0.15 } }),
    })
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.policy).toMatchObject({ ratePerPeriod: 0.02, periodDays: 14, capFraction: 0.15 })
  })
})

describe('POST /api/routes-b/late-fee-policies', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedRequireScope.mockRejectedValue(new RoutesBForbiddenError('missing'))
    const res = await POST(makePost({ ratePerPeriod: 0.015, periodDays: 30, capFraction: 0.1 }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when ratePerPeriod is missing', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const res = await POST(makePost({ periodDays: 30, capFraction: 0.1 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when ratePerPeriod exceeds 0.5', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const res = await POST(makePost({ ratePerPeriod: 0.6, periodDays: 30, capFraction: 0.1 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when periodDays is not an integer', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const res = await POST(makePost({ ratePerPeriod: 0.015, periodDays: 1.5, capFraction: 0.1 }))
    expect(res.status).toBe(400)
  })

  it('creates a policy for a new user and returns 201', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    settingsDelegate.findUnique.mockResolvedValue(null)
    settingsDelegate.create.mockResolvedValue({})
    const res = await POST(makePost({ ratePerPeriod: 0.02, periodDays: 14, capFraction: 0.15 }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.policy).toMatchObject({ ratePerPeriod: 0.02, periodDays: 14, capFraction: 0.15 })
    expect(settingsDelegate.create).toHaveBeenCalled()
  })

  it('updates an existing settings record', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    settingsDelegate.findUnique.mockResolvedValue({ id: 'rs-1', customMessage: null })
    settingsDelegate.update.mockResolvedValue({})
    const res = await POST(makePost({ ratePerPeriod: 0.015, periodDays: 30, capFraction: 0.1 }))
    expect(res.status).toBe(201)
    expect(settingsDelegate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rs-1' } }),
    )
  })
})
