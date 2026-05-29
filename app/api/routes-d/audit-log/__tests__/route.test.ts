import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({ prisma: { user: { findUnique: vi.fn() }, auditEvent: { findMany: vi.fn() } } }))
vi.mock('../_shared/logger', () => ({ createRouteLogger: vi.fn(() => ({ error: vi.fn() })) }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedAuditFindMany = vi.mocked(prisma.auditEvent.findMany)

function makeRequest(query = '') {
  return new NextRequest(`http://localhost/api/routes-d/audit-log${query}`, {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  })
}

describe('GET /api/routes-d/audit-log', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user-1' } as never)
    mockedAuditFindMany.mockResolvedValue([] as never)
  })

  it('returns 400 when the date range is invalid', async () => {
    const res = await GET(makeRequest('?from=2026-04-03T00:00:00.000Z&to=2026-04-02T00:00:00.000Z'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('from must be before or equal to to')
    expect(mockedAuditFindMany).not.toHaveBeenCalled()
  })

  it('applies actor filter and date range', async () => {
    await GET(makeRequest('?from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z&actor=user-2'))

    expect(mockedAuditFindMany).toHaveBeenCalledWith(
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

  it('defaults to a bounded 90-day range when no from/to provided', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-01T12:00:00.000Z'))

    await GET(makeRequest(''))

    expect(mockedAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-01-31T12:00:00.000Z'),
            lte: new Date('2026-05-01T12:00:00.000Z'),
          },
        }),
      }),
    )

    vi.useRealTimers()
  })
})
