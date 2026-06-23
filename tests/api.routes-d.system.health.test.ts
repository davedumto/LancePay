import { describe, it, expect, vi } from 'vitest'

const queryRaw = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: { $queryRaw: queryRaw },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

describe('GET /api/routes-d/system/health', () => {
  it('returns 200 with ok status when database is reachable', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }])
    const { GET } = await import('@/app/api/routes-d/system/health/route')
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.checks.database.status).toBe('ok')
    expect(typeof body.checks.database.latencyMs).toBe('number')
    expect(body.timestamp).toBeTruthy()
  })

  it('returns 503 with degraded status when database throws', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'))
    const { GET } = await import('@/app/api/routes-d/system/health/route')
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('degraded')
    expect(body.checks.database.status).toBe('error')
  })
})
