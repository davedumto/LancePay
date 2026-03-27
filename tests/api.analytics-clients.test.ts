import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const groupBy = vi.fn()
const findMany = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique,
    },
    invoice: {
      groupBy,
      findMany,
    },
  },
}))

describe('GET /api/routes-d/analytics/clients', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/analytics/clients/route')
    const request = new NextRequest('http://localhost/api/routes-d/analytics/clients')
    const response = await GET(request)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('returns an empty client list and uses the default limit', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_123' })
    findUnique.mockResolvedValue({ id: 'user_123' })
    groupBy.mockResolvedValueOnce([])

    const { GET } = await import('@/app/api/routes-d/analytics/clients/route')
    const request = new NextRequest('http://localhost/api/routes-d/analytics/clients')
    const response = await GET(request)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ clients: [] })
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
      }),
    )
    expect(findMany).not.toHaveBeenCalled()
  })

  it('clamps the limit and returns client analytics with paid counts', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_123' })
    findUnique.mockResolvedValue({ id: 'user_123' })
    groupBy
      .mockResolvedValueOnce([
        {
          clientEmail: 'alpha@example.com',
          _count: { id: 3 },
          _sum: { amount: '425.50' },
        },
        {
          clientEmail: 'beta@example.com',
          _count: { id: 1 },
          _sum: { amount: '80.00' },
        },
      ])
      .mockResolvedValueOnce([
        {
          clientEmail: 'alpha@example.com',
          _count: { id: 2 },
        },
      ])
    findMany.mockResolvedValue([
      {
        clientEmail: 'alpha@example.com',
        clientName: 'Newest Alpha Name',
      },
      {
        clientEmail: 'alpha@example.com',
        clientName: 'Older Alpha Name',
      },
      {
        clientEmail: 'beta@example.com',
        clientName: null,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/analytics/clients/route')
    const request = new NextRequest(
      'http://localhost/api/routes-d/analytics/clients?limit=999',
      {
        headers: {
          authorization: 'Bearer valid-token',
        },
      },
    )
    const response = await GET(request)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      clients: [
        {
          clientEmail: 'alpha@example.com',
          clientName: 'Newest Alpha Name',
          totalInvoiced: 425.5,
          invoiceCount: 3,
          paidCount: 2,
        },
        {
          clientEmail: 'beta@example.com',
          clientName: null,
          totalInvoiced: 80,
          invoiceCount: 1,
          paidCount: 0,
        },
      ],
    })
    expect(groupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 50,
      }),
    )
    expect(groupBy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'paid',
          clientEmail: { in: ['alpha@example.com', 'beta@example.com'] },
        }),
      }),
    )
  })
})
