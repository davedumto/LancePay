import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    apiVersion: {
      findMany: vi.fn(),
    },
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

import { GET, EDGE_CACHE_CONTROL, DEFAULT_API_VERSION } from './route'
import { prisma } from '@/lib/db'

const NOW = new Date('2026-10-17T12:00:00.000Z')

function makeRequest(query = ''): NextRequest {
  const suffix = query ? `?${query}` : ''
  return new NextRequest(`http://localhost/api/api-versions${suffix}`, {
    method: 'GET',
  })
}

describe('GET /api/api-versions (#1573)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    vi.mocked((prisma as any).apiVersion.findMany).mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns supported API versions with status, releaseDate, sunsetDate, and changelogUrl alongside currentDefaultVersion', async () => {
    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe(EDGE_CACHE_CONTROL)
    expect(res.headers.get('X-API-Default-Version')).toBe(DEFAULT_API_VERSION)

    const body = await res.json()
    expect(body.currentDefaultVersion).toBe('2026-06-01')
    expect(body.versionHeader).toBe('LancePay-Version')
    expect(Array.isArray(body.versions)).toBe(true)
    expect(body.versions.length).toBe(4)

    for (const v of body.versions) {
      expect(typeof v.version).toBe('string')
      expect(['current', 'active', 'deprecated', 'sunset']).toContain(v.status)
      expect(typeof v.releaseDate).toBe('string')
      expect(v).toHaveProperty('sunsetDate')
      expect(v.changelogUrl).toMatch(/^https:\/\/docs\.lancepay\.io\/changelog\//)
    }
  })

  it('preserves currentDefaultVersion at the top level even when filtering by ?status=deprecated', async () => {
    const res = await GET(makeRequest('status=deprecated'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.currentDefaultVersion).toBe('2026-06-01')
    expect(body.versions).toHaveLength(1)
    expect(body.versions[0].version).toBe('2025-05-01')
    expect(body.versions[0].status).toBe('deprecated')
  })

  it('excludes sunset versions when includeSunset=false', async () => {
    const res = await GET(makeRequest('includeSunset=false'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.versions.every((v: any) => v.status !== 'sunset')).toBe(true)
    expect(body.versions).toHaveLength(3)
  })

  it('integrates with prisma.apiVersion rows and promotes past sunsetDates to sunset status', async () => {
    vi.mocked((prisma as any).apiVersion.findMany).mockResolvedValue([
      {
        version: '2026-09-01',
        status: 'current',
        isDefault: true,
        releaseDate: new Date('2026-09-01T00:00:00.000Z'),
        deprecationDate: null,
        sunsetDate: null,
        changelogUrl: 'https://docs.lancepay.io/changelog/2026-09-01',
      },
      {
        version: '2025-01-01',
        status: 'deprecated',
        isDefault: false,
        releaseDate: new Date('2025-01-01T00:00:00.000Z'),
        deprecationDate: new Date('2025-09-01T00:00:00.000Z'),
        sunsetDate: new Date('2026-05-01T00:00:00.000Z'), // Past relative to NOW
        changelogUrl: 'https://docs.lancepay.io/changelog/2025-01-01',
      },
    ])

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.currentDefaultVersion).toBe('2026-09-01')
    expect(body.versions[1].version).toBe('2025-01-01')
    expect(body.versions[1].status).toBe('sunset')
  })

  it('returns 400 for invalid status or includeSunset query parameters', async () => {
    const badStatus = await GET(makeRequest('status=beta'))
    expect(badStatus.status).toBe(400)
    expect((await badStatus.json()).code).toBe('INVALID_STATUS_FILTER')

    const badInclude = await GET(makeRequest('includeSunset=maybe'))
    expect(badInclude.status).toBe(400)
    expect((await badInclude.json()).code).toBe('INVALID_QUERY_PARAM')
  })

  it('returns 500 when database lookup throws an unexpected error', async () => {
    vi.mocked((prisma as any).apiVersion.findMany).mockRejectedValue(new Error('db failure'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})
