import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '../route'
import { buildRequest } from '../../../_lib/test-helpers'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn(),
    sql: vi.fn((strings, ...values) => ({ strings, values })),
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockedFindUnique = vi.mocked(prisma.user.findUnique)
const mockedQueryRaw = vi.mocked(prisma.$queryRaw)
const mockedVerifyAuthToken = vi.mocked(verifyAuthToken)

describe('GET /api/routes-b/analytics/clients', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'user-1' } as any)
    mockedFindUnique.mockResolvedValue({ id: 'db-user-1' } as any)
  })

  it('defaults to top 10', async () => {
    mockedQueryRaw.mockResolvedValue([])

    const req = buildRequest('GET', 'http://localhost/api/routes-b/analytics/clients', { token: 'valid' })
    await GET(req)

    const values = (mockedQueryRaw.mock.calls[0][0] as any).values
    expect(values).toContain(10)
  })

  it('respects top parameter', async () => {
    mockedQueryRaw.mockResolvedValue([])

    const req = buildRequest('GET', 'http://localhost/api/routes-b/analytics/clients?top=5', { token: 'valid' })
    await GET(req)

    const values = (mockedQueryRaw.mock.calls[0][0] as any).values
    expect(values).toContain(5)
  })

  it('rejects top=0', async () => {
    const req = buildRequest('GET', 'http://localhost/api/routes-b/analytics/clients?top=0', { token: 'valid' })
    const res = await GET(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('top')
  })

  it('handles includeOthers=true', async () => {
    mockedQueryRaw.mockResolvedValue([
      { clientEmail: 'c1@ex.com', totalPaid: 100, rank: 1 },
      { clientEmail: 'others', totalPaid: 50, rank: 2 }
    ])

    const req = buildRequest('GET', 'http://localhost/api/routes-b/analytics/clients?top=1&includeOthers=true', { token: 'valid' })
    const res = await GET(req)
    const body = await res.json()

    expect(body.clients).toHaveLength(2)
    expect(body.clients[1].clientEmail).toBe('others')
    expect(body.clients[1].isOthers).toBe(true)
  })

  it('handles top exceeding total clients', async () => {
    mockedQueryRaw.mockResolvedValue([
      { clientEmail: 'c1@ex.com', totalPaid: 100, rank: 1 }
    ])

    const req = buildRequest('GET', 'http://localhost/api/routes-b/analytics/clients?top=50', { token: 'valid' })
    const res = await GET(req)
    const body = await res.json()

    expect(body.clients).toHaveLength(1)
    expect(body.clients[0].clientEmail).toBe('c1@ex.com')
  })
})
