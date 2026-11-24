import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    balanceThresholdAlert: { findMany: vi.fn(), update: vi.fn() },
    userWithdrawalBalance: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function call() {
  return POST(new NextRequest('http://localhost/api/balance-threshold-alerts/evaluate', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.balanceThresholdAlert.update).mockResolvedValue({} as never)
  vi.mocked(prisma.userWithdrawalBalance.findUnique).mockResolvedValue({ availableUsdc: 10 } as never)
})

describe('POST /api/balance-threshold-alerts/evaluate', () => {
  it('fires a below alert once, then again only after the balance recovers', async () => {
    vi.mocked(prisma.balanceThresholdAlert.findMany).mockResolvedValueOnce([
      { id: 'a1', currency: 'USDC', direction: 'below', threshold: 20, lastTriggeredAt: null },
    ] as never)
    const first = await call()
    expect(await first.json()).toEqual({ fired: ['a1'] })

    vi.mocked(prisma.balanceThresholdAlert.findMany).mockResolvedValueOnce([
      { id: 'a1', currency: 'USDC', direction: 'below', threshold: 20, lastTriggeredAt: new Date() },
    ] as never)
    const second = await call()
    expect(await second.json()).toEqual({ fired: [] })

    vi.mocked(prisma.userWithdrawalBalance.findUnique).mockResolvedValue({ availableUsdc: 50 } as never)
    vi.mocked(prisma.balanceThresholdAlert.findMany).mockResolvedValueOnce([
      { id: 'a1', currency: 'USDC', direction: 'below', threshold: 20, lastTriggeredAt: new Date() },
    ] as never)
    await call()
    expect(prisma.balanceThresholdAlert.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { lastTriggeredAt: null },
    })
  })

  it('does not evaluate a disabled alert', async () => {
    vi.mocked(prisma.balanceThresholdAlert.findMany).mockResolvedValue([])
    await call()
    expect(prisma.balanceThresholdAlert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', enabled: true } }),
    )
    expect(prisma.balanceThresholdAlert.update).not.toHaveBeenCalled()
  })
})
