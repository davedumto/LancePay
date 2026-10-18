import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  digestEmailSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET, PATCH } from './route'

describe('GET, PATCH /api/settings/digest-email', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:user_deg_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_deg_1' })
  })

  it('upserts on first PATCH and returns lastSentAt in the response', async () => {
    mockPrisma.digestEmailSettings.upsert.mockImplementation(
      async ({ create }: { create: Record<string, unknown> }) => ({
        id: 'deg_1',
        ...create,
        lastSentAt: null,
        createdAt: new Date('2026-06-05T10:00:00.000Z'),
        updatedAt: new Date('2026-06-05T10:00:00.000Z'),
      }),
    )

    const req = new NextRequest('http://localhost/api/settings/digest-email', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer valid_token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        enabled: true,
        frequency: 'daily',
      }),
    })

    const res = await PATCH(req)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(mockPrisma.digestEmailSettings.upsert).toHaveBeenCalledWith({
      where: { userId: 'user_deg_1' },
      update: {
        enabled: true,
        frequency: 'daily',
      },
      create: {
        userId: 'user_deg_1',
        enabled: true,
        frequency: 'daily',
      },
    })

    expect(body.settings).toMatchObject({
      id: 'deg_1',
      userId: 'user_deg_1',
      enabled: true,
      frequency: 'daily',
      lastSentAt: null,
    })
    expect(body.lastSentAt).toBeNull()
  })

  it('validates frequency is one of daily, weekly, or monthly', async () => {
    const invalidFreqReq = new NextRequest(
      'http://localhost/api/settings/digest-email',
      {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          frequency: 'hourly',
        }),
      },
    )

    const invalidRes = await PATCH(invalidFreqReq)
    expect(invalidRes.status).toBe(400)
    const invalidBody = await invalidRes.json()
    expect(invalidBody.code).toBe('INVALID_DIGEST_FREQUENCY')
    expect(mockPrisma.digestEmailSettings.upsert).not.toHaveBeenCalled()

    // Valid frequencies ('daily', 'weekly', 'monthly') succeed
    for (const freq of ['daily', 'weekly', 'monthly'] as const) {
      mockPrisma.digestEmailSettings.upsert.mockResolvedValueOnce({
        id: 'deg_1',
        userId: 'user_deg_1',
        enabled: true,
        frequency: freq,
        lastSentAt: new Date('2026-06-04T09:00:00.000Z'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-05T10:00:00.000Z'),
      })

      const validReq = new NextRequest(
        'http://localhost/api/settings/digest-email',
        {
          method: 'PATCH',
          headers: {
            authorization: 'Bearer valid_token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ frequency: freq }),
        },
      )
      const validRes = await PATCH(validReq)
      expect(validRes.status).toBe(200)
      const validBody = await validRes.json()
      expect(validBody.settings.frequency).toBe(freq)
    }
  })

  it('returns lastSentAt on GET and PATCH so the user can see when their last digest actually went out', async () => {
    const sentTimestamp = new Date('2026-06-03T18:30:00.000Z')
    mockPrisma.digestEmailSettings.findUnique.mockResolvedValue({
      id: 'deg_1',
      userId: 'user_deg_1',
      enabled: true,
      frequency: 'weekly',
      lastSentAt: sentTimestamp,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-03T18:30:00.000Z'),
    })

    const getReq = new NextRequest(
      'http://localhost/api/settings/digest-email',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const getRes = await GET(getReq)
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json()

    expect(getBody.lastSentAt).toBe('2026-06-03T18:30:00.000Z')
    expect(getBody.settings.lastSentAt).toBe('2026-06-03T18:30:00.000Z')
    expect(getBody.settings.frequency).toBe('weekly')
  })
})
