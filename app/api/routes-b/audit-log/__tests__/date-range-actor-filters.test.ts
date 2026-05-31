import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditEvent: { findMany: vi.fn(), count: vi.fn() },
  },
}))

vi.mock('../_lib/audit-severity', () => ({
  getSeverity: vi.fn(() => 'info'),
  buildSeverityFilter: vi.fn(() => ({})),
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedFindMany = vi.mocked(prisma.auditEvent.findMany)
const mockedCount = vi.mocked(prisma.auditEvent.count)

function makeRequest(query = '') {
  return new NextRequest(`http://localhost/api/routes-b/audit-log${query}`, {
    headers: { authorization: 'Bearer token' },
  })
}

describe('GET /api/routes-b/audit-log date-range and actor filters', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-28T12:00:00.000Z'))
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user-1' } as never)
    mockedFindMany.mockResolvedValue([] as never)
    mockedCount.mockResolvedValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses default 90-day range when no dates provided', async () => {
    await GET(makeRequest())

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          actorId: 'user-1',
          createdAt: {
            gte: new Date('2026-01-28T12:00:00.000Z'), // 90 days before
            lte: new Date('2026-04-28T12:00:00.000Z'), // now
          },
        }),
      }),
    )
  })

  it('applies custom date range', async () => {
    await GET(makeRequest('?from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z'))

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-04-01T00:00:00.000Z'),
            lte: new Date('2026-04-02T00:00:00.000Z'),
          },
        }),
      }),
    )
  })

  it('rejects invalid date ranges', async () => {
    const res = await GET(makeRequest('?from=2026-04-03T00:00:00.000Z&to=2026-04-02T00:00:00.000Z'))

    expect(res.status).toBe(400)
    expect(mockedFindMany).not.toHaveBeenCalled()
  })

  it('rejects date ranges exceeding 365 days', async () => {
    const res = await GET(makeRequest('?from=2025-04-01T00:00:00.000Z&to=2026-04-28T00:00:00.000Z'))

    expect(res.status).toBe(400)
    expect(mockedFindMany).not.toHaveBeenCalled()
  })

  it('applies actor filter', async () => {
    await GET(makeRequest('?actor=user-2'))

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ 
          actorId: 'user-2' // Should use provided actor instead of current user
        }),
      }),
    )
  })

  it('combines date range and actor filters', async () => {
    await GET(makeRequest('?from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z&actor=user-2'))

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          actorId: 'user-2',
          createdAt: {
            gte: new Date('2026-04-01T00:00:00.000Z'),
            lte: new Date('2026-04-02T00:00:00.000Z'),
          },
        }),
      }),
    )
  })

  it('handles invalid date format', async () => {
    const res = await GET(makeRequest('?from=invalid-date'))

    expect(res.status).toBe(400)
    expect(mockedFindMany).not.toHaveBeenCalled()
  })

  it('trims whitespace from actor parameter', async () => {
    await GET(makeRequest('?actor=%20user-2%20')) // URL encoded spaces

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorId: 'user-2' }),
      }),
    )
  })

  it('ignores empty actor parameter', async () => {
    await GET(makeRequest('?actor='))

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorId: 'user-1' }), // Falls back to current user
      }),
    )
  })
})