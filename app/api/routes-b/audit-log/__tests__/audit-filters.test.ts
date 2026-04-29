import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../[id]/route'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditEvent: { findMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedFindMany = vi.mocked(prisma.auditEvent.findMany)

function makeRequest(query = '') {
  return new NextRequest(`http://localhost/api/routes-b/audit-log/inv-1${query}`, {
    headers: { authorization: 'Bearer token' },
  })
}

function context() {
  return { params: Promise.resolve({ id: 'inv-1' }) }
}

describe('GET /api/routes-b/audit-log/[id] filters', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-28T12:00:00.000Z'))
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user-1' } as never)
    mockedFindMany.mockResolvedValue([] as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses a default 90-day range', async () => {
    await GET(makeRequest(), context())

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          invoiceId: 'inv-1',
          createdAt: {
            gte: new Date('2026-01-28T12:00:00.000Z'),
            lte: new Date('2026-04-28T12:00:00.000Z'),
          },
        }),
      }),
    )
  })

  it('applies a narrow inclusive date range', async () => {
    await GET(makeRequest('?from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z'), context())

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

  it('rejects invalid ranges', async () => {
    const res = await GET(makeRequest('?from=2026-04-03T00:00:00.000Z&to=2026-04-02T00:00:00.000Z'), context())

    expect(res.status).toBe(400)
    expect(mockedFindMany).not.toHaveBeenCalled()
  })

  it('applies actor filter', async () => {
    await GET(makeRequest('?actor=user-2'), context())

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorId: 'user-2' }),
      }),
    )
  })

  it('combines date range and actor filters', async () => {
    await GET(makeRequest('?from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z&actor=user-2'), context())

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
})
