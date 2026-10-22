import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    discount: { findMany: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'

function makeRequest(method: 'GET' | 'POST' = 'GET', body?: any) {
  return new NextRequest(`http://localhost:3000/api/discounts`, {
    method,
    headers: { Authorization: 'Bearer valid-token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
})

describe('GET /api/discounts', () => {
  it('returns list of discounts for authenticated user', async () => {
    const mockDiscounts = [
      {
        id: 'disc-1',
        code: 'SUMMER20',
        type: 'percent',
        value: 20,
        active: true,
        maxRedemptions: 100,
        redemptions: 5,
        expiresAt: new Date('2026-12-31'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'disc-2',
        code: 'FLAT10',
        type: 'fixed',
        value: 10,
        active: true,
        maxRedemptions: null,
        redemptions: 0,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
    vi.mocked(prisma.discount.findMany).mockResolvedValue(mockDiscounts as never)

    const res = await GET(makeRequest('GET'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.discounts).toHaveLength(2)
    expect(data.discounts[0].code).toBe('SUMMER20')
    expect(data.discounts[1].code).toBe('FLAT10')
  })

  it('returns empty list when user has no discounts', async () => {
    vi.mocked(prisma.discount.findMany).mockResolvedValue([])

    const res = await GET(makeRequest('GET'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.discounts).toEqual([])
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/discounts`)
    const res = await GET(request)
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record cannot be found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(404)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.discount.findMany).mockRejectedValue(new Error('DB error'))
    const res = await GET(makeRequest('GET'))
    const data = await res.json()
    expect(res.status).toBe(500)
    expect(data.error).toBe('Failed to fetch discounts')
  })

  it('scopes discounts to authenticated user', async () => {
    vi.mocked(prisma.discount.findMany).mockResolvedValue([])
    await GET(makeRequest('GET'))
    expect(prisma.discount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: mockUserId } }),
    )
  })
})

describe('POST /api/discounts', () => {
  it('creates a percent discount with valid data', async () => {
    const mockDiscount = {
      id: 'disc-1',
      code: 'SUMMER20',
      type: 'percent',
      value: 20,
      active: true,
      maxRedemptions: 100,
      redemptions: 0,
      expiresAt: new Date('2026-12-31'),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.discount.create).mockResolvedValue(mockDiscount as never)

    const res = await POST(
      makeRequest('POST', {
        code: 'SUMMER20',
        type: 'percent',
        value: 20,
        maxRedemptions: 100,
        expiresAt: '2026-12-31',
        active: true,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.discount.code).toBe('SUMMER20')
    expect(data.discount.type).toBe('percent')
    expect(data.discount.value).toBe(20)
  })

  it('creates a fixed discount with valid data', async () => {
    const mockDiscount = {
      id: 'disc-2',
      code: 'FLAT10',
      type: 'fixed',
      value: 10,
      active: true,
      maxRedemptions: null,
      redemptions: 0,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.discount.create).mockResolvedValue(mockDiscount as never)

    const res = await POST(
      makeRequest('POST', {
        code: 'FLAT10',
        type: 'fixed',
        value: 10,
        active: true,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.discount.type).toBe('fixed')
    expect(data.discount.value).toBe(10)
  })

  it('defaults active to true', async () => {
    const mockDiscount = {
      id: 'disc-1',
      code: 'TEST',
      type: 'percent',
      value: 10,
      active: true,
      maxRedemptions: null,
      redemptions: 0,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.discount.create).mockResolvedValue(mockDiscount as never)

    const res = await POST(
      makeRequest('POST', {
        code: 'TEST',
        type: 'percent',
        value: 10,
        // active not provided
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.discount.active).toBe(true)
  })

  it('rejects percent discount with value > 100', async () => {
    const res = await POST(
      makeRequest('POST', {
        code: 'INVALID',
        type: 'percent',
        value: 150,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain('percent discount value must be between 0 and 100')
  })

  it('rejects missing code', async () => {
    const res = await POST(
      makeRequest('POST', {
        type: 'percent',
        value: 20,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain('code is required')
  })

  it('rejects invalid type', async () => {
    const res = await POST(
      makeRequest('POST', {
        code: 'TEST',
        type: 'invalid',
        value: 20,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain('type must be one of')
  })

  it('rejects missing value', async () => {
    const res = await POST(
      makeRequest('POST', {
        code: 'TEST',
        type: 'percent',
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain('value is required')
  })

  it('rejects negative value', async () => {
    const res = await POST(
      makeRequest('POST', {
        code: 'TEST',
        type: 'fixed',
        value: -10,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain('value must be a non-negative number')
  })

  it('rejects invalid maxRedemptions', async () => {
    const res = await POST(
      makeRequest('POST', {
        code: 'TEST',
        type: 'percent',
        value: 20,
        maxRedemptions: 0,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain('maxRedemptions must be a positive integer')
  })

  it('rejects invalid expiresAt date', async () => {
    const res = await POST(
      makeRequest('POST', {
        code: 'TEST',
        type: 'percent',
        value: 20,
        expiresAt: 'not-a-date',
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain('expiresAt must be a valid ISO date string')
  })

  it('returns 409 on unique constraint violation (duplicate code)', async () => {
    vi.mocked(prisma.discount.create).mockRejectedValue({
      code: 'P2002',
      meta: { target: ['code'] },
    } as never)

    const res = await POST(
      makeRequest('POST', {
        code: 'DUPLICATE',
        type: 'percent',
        value: 20,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(409)
    expect(data.error).toContain('already exists')
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/discounts`, {
      method: 'POST',
      body: JSON.stringify({ code: 'TEST', type: 'percent', value: 20 }),
    })
    const res = await POST(request)
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(
      makeRequest('POST', {
        code: 'TEST',
        type: 'percent',
        value: 20,
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record cannot be found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await POST(
      makeRequest('POST', {
        code: 'TEST',
        type: 'percent',
        value: 20,
      }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid JSON body', async () => {
    const request = new NextRequest(`http://localhost:3000/api/discounts`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' },
      body: 'not json',
    })
    const res = await POST(request)
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error).toBe('Invalid JSON body')
  })

  it('stores discount with userId', async () => {
    const mockDiscount = {
      id: 'disc-1',
      code: 'TEST',
      type: 'percent',
      value: 20,
      active: true,
      maxRedemptions: null,
      redemptions: 0,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.discount.create).mockResolvedValue(mockDiscount as never)

    await POST(
      makeRequest('POST', {
        code: 'TEST',
        type: 'percent',
        value: 20,
      }),
    )

    expect(prisma.discount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: mockUserId,
          code: 'TEST',
        }),
      }),
    )
  })
})
