import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    balanceThresholdAlert: { findMany: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function req(method: 'GET' | 'POST', body?: string) {
  return new NextRequest('http://localhost/api/balance-threshold-alerts', {
    method,
    headers: { authorization: 'Bearer token' },
    body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
})

describe('POST /api/balance-threshold-alerts', () => {
  it('defaults enabled to true and allows another alert for the same user', async () => {
    vi.mocked(prisma.balanceThresholdAlert.create).mockResolvedValue({ id: 'a1', enabled: true } as never)
    const res = await POST(req('POST', JSON.stringify({ direction: 'below', threshold: 25, currency: 'USDC' })))
    expect(res.status).toBe(201)
    expect(prisma.balanceThresholdAlert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', direction: 'below', threshold: 25, enabled: true }),
      }),
    )
  })

  it('rejects a negative threshold and an unknown direction', async () => {
    expect((await POST(req('POST', JSON.stringify({ direction: 'below', threshold: -1 })))).status).toBe(400)
    expect((await POST(req('POST', JSON.stringify({ direction: 'sideways', threshold: 1 })))).status).toBe(400)
    expect(prisma.balanceThresholdAlert.create).not.toHaveBeenCalled()
  })
})

describe('GET /api/balance-threshold-alerts', () => {
  it('returns 401 without a token', async () => {
    const res = await GET(new NextRequest('http://localhost/api/balance-threshold-alerts'))
    expect(res.status).toBe(401)
  })
})
