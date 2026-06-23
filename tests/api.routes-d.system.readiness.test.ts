import { describe, it, expect, vi } from 'vitest'

const queryRaw = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: { $queryRaw: queryRaw },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

describe('GET /api/routes-d/system/readiness', () => {
  it('returns 200 ready:true when database responds', async () => {
    queryRaw.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-d/system/readiness/route')
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ready).toBe(true)
    expect(body.checks.database).toBe('ok')
  })

  it('returns 503 ready:false when database throws', async () => {
    queryRaw.mockRejectedValue(new Error('timeout'))
    const { GET } = await import('@/app/api/routes-d/system/readiness/route')
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ready).toBe(false)
    expect(body.checks.database).toBe('error')
  })
})
