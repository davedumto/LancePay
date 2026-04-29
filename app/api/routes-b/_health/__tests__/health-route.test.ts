import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '../route'

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}))

import { prisma } from '@/lib/db'

const mockedQueryRaw = vi.mocked(prisma.$queryRaw)

describe('GET /api/routes-b/_health', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 200 when db check is healthy', async () => {
    mockedQueryRaw.mockResolvedValue([{ '?column?': 1 }] as never)

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.checks.db).toBe('ok')
    expect(typeof body.checks.time).toBe('string')
    expect(typeof body.checks.version).toBe('string')
  })

  it('returns 503 when db check is slow', async () => {
    mockedQueryRaw.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([{ '?column?': 1 }]), 300)
        }) as never,
    )

    const started = Date.now()
    const res = await GET()
    const elapsed = Date.now() - started
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.checks.db).toBe('degraded')
    expect(elapsed).toBeLessThan(500)
  })

  it('returns 503 when db check throws', async () => {
    mockedQueryRaw.mockRejectedValue(new Error('db offline'))

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).toEqual({
      ok: false,
      checks: {
        db: 'degraded',
        time: expect.any(String),
        version: expect.any(String),
      },
    })
  })
})

