/**
 * Tests for issue #709 — GET /api/routes-b/invoices/summary
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { groupBy: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../invoices/summary/route'

const BASE_URL = 'http://localhost/api/routes-b/invoices/summary'

function makeRequest(authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('GET /api/routes-b/invoices/summary (#709)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 401 when authorization header is missing', async () => {
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(verifyAuthToken).not.toHaveBeenCalled()
  })

  it('returns 401 when token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Invalid token' })
  })

  it('returns 404 when user does not exist', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'User not found' })
    expect(prisma.invoice.groupBy).not.toHaveBeenCalled()
  })

  it('returns status summary with all known statuses for authenticated user', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
    vi.mocked(prisma.invoice.groupBy).mockResolvedValue([
      { status: 'paid', _count: { id: 2 }, _sum: { amount: 150 } },
      { status: 'pending', _count: { id: 1 }, _sum: { amount: 50 } },
    ] as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.summary).toEqual([
      { status: 'pending', count: 1, total: 50 },
      { status: 'paid', count: 2, total: 150 },
      { status: 'cancelled', count: 0, total: 0 },
      { status: 'overdue', count: 0, total: 0 },
    ])
    expect(prisma.invoice.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    )
  })

  it('returns 500 on unexpected database error', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
    vi.mocked(prisma.invoice.groupBy).mockRejectedValue(new Error('DB failure') as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'Failed to get invoice summary' })
  })
})
