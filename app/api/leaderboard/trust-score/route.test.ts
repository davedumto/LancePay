import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    userTrustScore: {
      findMany: vi.fn(),
    },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'

function request(url = 'http://localhost/api/leaderboard/trust-score') {
  return new NextRequest(url)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/leaderboard/trust-score', () => {
  it('returns a paginated leaderboard excluding opted-out users', async () => {
    const mockScores = [
      { id: 'ts-1', score: 90, user: { id: 'u-1', name: 'Alice', createdAt: new Date('2025-01-01') } },
      { id: 'ts-2', score: 85, user: { id: 'u-2', name: 'Bob', createdAt: new Date('2025-01-02') } },
      { id: 'ts-3', score: 85, user: { id: 'u-3', name: 'Charlie', createdAt: new Date('2025-01-03') } }, // Tie break
    ]
    
    vi.mocked(prisma.userTrustScore.findMany).mockResolvedValue([...mockScores, { id: 'ts-4' }] as any)

    const response = await GET(request('http://localhost/api/leaderboard/trust-score?limit=3'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(3)
    expect(body.data[0].id).toBe('ts-1')
    expect(body.nextCursor).toBe('ts-4')
    
    expect(prisma.userTrustScore.findMany).toHaveBeenCalledWith({
      where: { user: { publicVisibility: true } },
      take: 4,
      cursor: undefined,
      orderBy: [
        { score: 'desc' },
        { user: { createdAt: 'asc' } },
        { id: 'asc' },
      ],
      select: expect.any(Object),
    })
  })

  it('supports cursor-based pagination', async () => {
    vi.mocked(prisma.userTrustScore.findMany).mockResolvedValue([{ id: 'ts-5' }] as any)

    const response = await GET(request('http://localhost/api/leaderboard/trust-score?limit=1&cursor=ts-4'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(prisma.userTrustScore.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        cursor: { id: 'ts-4' },
      })
    )
    expect(body.data).toHaveLength(1)
    expect(body.nextCursor).toBeUndefined()
  })

  it('returns 500 when database fails', async () => {
    vi.mocked(prisma.userTrustScore.findMany).mockRejectedValue(new Error('DB Error'))
    const response = await GET(request())
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to fetch leaderboard' })
  })
})
