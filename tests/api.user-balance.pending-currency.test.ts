import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '@/app/api/user/balance/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getAccountBalance } from '@/lib/stellar'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    invoice: { groupBy: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/stellar', () => ({ getAccountBalance: vi.fn() }))
vi.mock('@/lib/assets', () => ({ resolveAssetMetadata: vi.fn().mockReturnValue({}) }))
vi.mock('@/lib/pricing', () => ({ getAssetPrices: vi.fn().mockResolvedValue({ USDC: { price: 1, currency: 'USD' } }) }))
vi.mock('@/lib/exchange-rate', () => ({ getUsdToNgnRate: vi.fn().mockResolvedValue({ rate: 1500 }) }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

describe('GET /api/user/balance pending invoices by currency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-1',
      privyId: 'privy-1',
      wallet: { address: 'G123' },
    } as never)
    vi.mocked(getAccountBalance).mockResolvedValue([{ asset_code: 'USDC', balance: '0' }] as never)
  })

  it('does not sum pending amounts across different currencies into the USD total', async () => {
    vi.mocked(prisma.invoice.groupBy).mockResolvedValue([
      { currency: 'USD', _sum: { amount: 500 } },
      { currency: 'NGN', _sum: { amount: 500000 } },
    ] as never)

    const req = new Request('http://localhost/api/user/balance', {
      headers: { authorization: 'Bearer token' },
    })

    const res = await GET(req as never)
    const json = await res.json()

    expect(json.pending).toEqual({ amount: 500, currency: 'USD' })
    expect(json.pendingByCurrency).toEqual([
      { currency: 'USD', amount: 500 },
      { currency: 'NGN', amount: 500000 },
    ])
  })
})
