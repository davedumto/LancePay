import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findMany: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('../../../_lib/csv-stream', () => ({
  createCsvStream: vi.fn((_cols, fetcher) => {
    const encoder = new TextEncoder()
    return new ReadableStream({
      async start(controller) {
        const rows = await fetcher(null, 100)
        for (const row of rows) {
          controller.enqueue(encoder.encode(JSON.stringify(row) + '\n'))
        }
        controller.close()
      },
    })
  }),
}))

vi.mock('../../../_lib/errors', () => ({
  errorResponse: vi.fn((code, message, _opts, status) => {
    return new Response(JSON.stringify({ error: { code, message } }), { status })
  }),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function makeRequest(params = '') {
  return new NextRequest(`http://localhost/api/routes-b/transactions/export${params}`, {
    headers: { authorization: 'Bearer test-token' },
  })
}

describe('GET /api/routes-b/transactions/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports transactions as CSV stream', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: 't1', type: 'payment', status: 'completed', amount: 100, currency: 'USDC', createdAt: new Date(), invoice: { description: 'Test' } },
    ])

    const { GET } = await import('../route')
    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv')
    expect(res.headers.get('Content-Disposition')).toContain('transactions.csv')
  })

  it('filters by date range when provided', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([])

    const { GET } = await import('../route')
    const res = await GET(makeRequest('?from=2026-01-01&to=2026-03-31'))

    expect(res.status).toBe(200)
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      }),
    )
  })

  it('returns 400 for invalid from date', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })

    const { GET } = await import('../route')
    const res = await GET(makeRequest('?from=not-a-date'))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('returns 400 for invalid to date', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })

    const { GET } = await import('../route')
    const res = await GET(makeRequest('?to=not-a-date'))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('returns 401 for missing auth token', async () => {
    const { GET } = await import('../route')
    const req = new NextRequest('http://localhost/api/routes-b/transactions/export')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 401 for invalid token', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 404 when user not found', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
