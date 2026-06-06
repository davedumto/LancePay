/**
 * Tests for issue #706 — GET /api/routes-b/invoices/paid
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../invoices/paid/route'

const BASE_URL = 'http://localhost/api/routes-b/invoices/paid'

function makeRequest(query = '', authHeader: string | null = 'Bearer token') {
  return new NextRequest(`${BASE_URL}${query}`, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('GET /api/routes-b/invoices/paid (#706)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 401 when authorization header is missing', async () => {
    const res = await GET(makeRequest('', null))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
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
  })

  it('returns 400 for an invalid cursor', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
    const res = await GET(makeRequest('?cursor=not-valid'))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'Invalid cursor' })
  })

  it('returns paid invoices scoped to the authenticated user', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
    const paidAt = new Date('2026-01-15T00:00:00.000Z')
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-001',
        clientName: 'Acme',
        clientEmail: 'acme@example.com',
        amount: '250.50',
        currency: 'USDC',
        paidAt,
        createdAt: paidAt,
      },
    ] as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.invoices).toHaveLength(1)
    expect(body.invoices[0]).toMatchObject({
      id: 'inv-1',
      invoiceNumber: 'INV-001',
      amount: 250.5,
    })
    expect(body.nextCursor).toBeNull()
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1', status: 'paid' }),
      }),
    )
  })

  it('returns 500 on unexpected database error', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
    vi.mocked(prisma.invoice.findMany).mockRejectedValue(new Error('DB failure') as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'Failed to list paid invoices' })
  })
})
