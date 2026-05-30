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

function makeRequest(query = '', auth = 'Bearer token') {
  return new NextRequest(`http://localhost/api/routes-d/audit-log${query}`, {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

const fakeEvents = [
  {
    id: 'evt-1',
    eventType: 'invoice.created',
    invoiceId: 'inv-1',
    actorId: 'user-1',
    metadata: null,
    signature: 'sig',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
]

describe('GET /api/routes-d/audit-log', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user-1' } as never)
    mockedAuditFindMany.mockResolvedValue([] as never)
  })

  it('returns 401 when no token is supplied', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const req = new NextRequest('http://localhost/api/routes-d/audit-log', { method: 'GET' })
    expect((await GET(req)).status).toBe(401)
  })

  it('returns 401 when token does not verify', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(makeRequest(''))).status).toBe(401)
  })

  it('returns 404 when user cannot be resolved from claims', async () => {
    mockedUserFindUnique.mockResolvedValue(null as never)
    expect((await GET(makeRequest(''))).status).toBe(404)
  })

  it('returns 400 when the date range is invalid', async () => {
    const res = await GET(makeRequest('?from=2026-04-03T00:00:00.000Z&to=2026-04-02T00:00:00.000Z'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('from must be before or equal to to')
    expect(mockedAuditFindMany).not.toHaveBeenCalled()
  })

  it('always filters by the authenticated user regardless of actor param', async () => {
    await GET(makeRequest('?from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z&actor=other-user'))

    expect(mockedAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          actorId: 'user-1',
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

  it('returns 200 with mapped events on success', async () => {
    mockedAuditFindMany.mockResolvedValue(fakeEvents as never)
    const res = await GET(makeRequest(''))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({
      id: 'evt-1',
      action: 'invoice.created',
      resourceType: 'invoice',
      resourceId: 'inv-1',
    })
  })

  it('uses default limit of 20 when no limit param is supplied', async () => {
    await GET(makeRequest(''))
    expect(mockedAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    )
  })

  it('caps limit at 100', async () => {
    await GET(makeRequest('?limit=999'))
    expect(mockedAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    )
  })

  it('falls back to default limit of 20 for a non-numeric limit', async () => {
    await GET(makeRequest('?limit=abc'))
    expect(mockedAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    )
  })

  it('falls back to default limit of 20 for a negative limit', async () => {
    await GET(makeRequest('?limit=-5'))
    expect(mockedAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    )
  })

  it('filters by eventType when action query param is provided', async () => {
    await GET(makeRequest('?action=invoice.paid'))
    expect(mockedAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventType: 'invoice.paid' }),
      }),
    )
  })
})
