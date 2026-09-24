import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '@/app/api/time-entries/unbilled-summary/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    timeEntry: { findMany: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

const mockUser = { id: 'user-1', email: 'freelancer@example.com' }

function makeRequest(token = 'Bearer valid-token') {
  return new Request('http://localhost/api/time-entries/unbilled-summary', {
    method: 'GET',
    headers: { authorization: token },
  }) as unknown as import('next/server').NextRequest
}

describe('GET /api/time-entries/unbilled-summary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
  })

  it('aggregates hours and amount per project', async () => {
    vi.mocked(prisma.timeEntry.findMany).mockResolvedValue([
      { hours: 2, project: { id: 'p1', title: 'Alpha', rateUsdc: 50 } },
      { hours: 3, project: { id: 'p1', title: 'Alpha', rateUsdc: 50 } },
    ] as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.projects).toHaveLength(1)
    expect(json.projects[0].totalHours).toBe(5)
    expect(json.projects[0].estimatedAmount).toBe(250)
    expect(json.projects[0].missingRate).toBe(false)
    expect(json.totalUnbilledHours).toBe(5)
    expect(json.totalEstimatedAmount).toBe(250)
  })

  it('flags projects with no configured rate instead of computing zero', async () => {
    vi.mocked(prisma.timeEntry.findMany).mockResolvedValue([
      { hours: 4, project: { id: 'p2', title: 'Beta', rateUsdc: null } },
    ] as never)
    const res = await GET(makeRequest())
    const json = await res.json()
    expect(json.projects[0].missingRate).toBe(true)
    expect(json.projects[0].estimatedAmount).toBeNull()
    expect(json.hasUnratedProjects).toBe(true)
  })

  it('groups entries with no project under an unassigned bucket and flags them', async () => {
    vi.mocked(prisma.timeEntry.findMany).mockResolvedValue([
      { hours: 1, project: null },
    ] as never)
    const res = await GET(makeRequest())
    const json = await res.json()
    expect(json.projects[0].projectId).toBeNull()
    expect(json.projects[0].missingRate).toBe(true)
    expect(json.projects[0].estimatedAmount).toBeNull()
  })

  it('returns empty totals when there are no unbilled entries', async () => {
    vi.mocked(prisma.timeEntry.findMany).mockResolvedValue([] as never)
    const res = await GET(makeRequest())
    const json = await res.json()
    expect(json.projects).toHaveLength(0)
    expect(json.totalUnbilledHours).toBe(0)
    expect(json.hasUnratedProjects).toBe(false)
  })

  it('excludes billed and invoiced entries via the query filter', async () => {
    vi.mocked(prisma.timeEntry.findMany).mockResolvedValue([] as never)
    await GET(makeRequest())
    expect(prisma.timeEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          invoiceId: null,
          status: { not: 'billed' },
        }),
      }),
    )
  })

  it('rejects an unauthenticated request', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })
})
