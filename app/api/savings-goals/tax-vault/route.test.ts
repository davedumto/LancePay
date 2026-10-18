import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    savingsGoal: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const actor = { id: 'user-1', email: 'saver@example.com' }

function makeTaxVault(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vault-1',
    title: '2026 Federal Tax Vault',
    targetAmountUsdc: new Decimal('5000.000000'),
    currentAmountUsdc: new Decimal('1750.000000'),
    savingsPercentage: 25,
    isActive: true,
    status: 'in_progress',
    isTaxVault: true,
    createdAt: new Date('2026-01-15T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  }
}

function makeRequest(authHeader = 'Bearer valid-token'): NextRequest {
  const headers: Record<string, string> = {}
  if (authHeader) headers.authorization = authHeader
  return new NextRequest('http://localhost/api/savings-goals/tax-vault', {
    method: 'GET',
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
})

describe('GET /api/savings-goals/tax-vault', () => {
  it('returns 404 when no tax vault exists for the authenticated user', async () => {
    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValue([])

    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('TAX_VAULT_NOT_FOUND')
    expect(prisma.savingsGoal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', isTaxVault: true },
      })
    )
  })

  it('computes projected liability estimate, shortfall, progress percentage, and early withdrawal penalty', async () => {
    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValue([makeTaxVault()] as any)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.multipleTaxVaults).toBe(false)
    expect(body.taxVaultCount).toBe(1)
    expect(body.taxVault.id).toBe('vault-1')
    expect(body.liabilityEstimate).toEqual({
      projectedLiabilityUsdc: '5000.000000',
      reservedAmountUsdc: '1750.000000',
      shortfallUsdc: '3250.000000',
      surplusUsdc: '0.000000',
      fundingProgressPercent: 35,
      isFullyFunded: false,
      earlyWithdrawalPenalty: {
        applies: true,
        percentage: 10,
        estimatedPenaltyUsdc: '175.000000',
        netAvailableUsdc: '1575.000000',
      },
    })
  })

  it('handles multiple tax vault goals defensively by selecting the primary active in_progress goal and aggregating non-withdrawn balances', async () => {
    const withdrawnVault = makeTaxVault({
      id: 'vault-old',
      status: 'withdrawn',
      isActive: false,
      targetAmountUsdc: new Decimal('2000.000000'),
      currentAmountUsdc: new Decimal('0.000000'),
    })
    const completedVault = makeTaxVault({
      id: 'vault-completed',
      status: 'completed',
      isActive: false,
      targetAmountUsdc: new Decimal('3000.000000'),
      currentAmountUsdc: new Decimal('3000.000000'),
    })
    const primaryActiveVault = makeTaxVault({
      id: 'vault-active',
      status: 'in_progress',
      isActive: true,
      targetAmountUsdc: new Decimal('4000.000000'),
      currentAmountUsdc: new Decimal('1000.000000'),
    })

    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValue([
      withdrawnVault,
      completedVault,
      primaryActiveVault,
    ] as any)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.multipleTaxVaults).toBe(true)
    expect(body.taxVaultCount).toBe(3)
    expect(body.taxVault.id).toBe('vault-active')
    expect(body.liabilityEstimate.projectedLiabilityUsdc).toBe('4000.000000')
    expect(body.liabilityEstimate.reservedAmountUsdc).toBe('1000.000000')
    expect(body.liabilityEstimate.shortfallUsdc).toBe('3000.000000')

    // Aggregate excludes withdrawnVault and sums completedVault (3000/3000) + primaryActiveVault (1000/4000)
    expect(body.aggregateLiabilityEstimate.projectedLiabilityUsdc).toBe('7000.000000')
    expect(body.aggregateLiabilityEstimate.reservedAmountUsdc).toBe('4000.000000')
    expect(body.aggregateLiabilityEstimate.shortfallUsdc).toBe('3000.000000')
    expect(body.allTaxVaults).toHaveLength(3)
  })

  it('computes surplus and waives early penalty when currentAmountUsdc exceeds targetAmountUsdc or returns 401 when unauthenticated', async () => {
    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValue([
      makeTaxVault({
        status: 'completed',
        targetAmountUsdc: new Decimal('2000.000000'),
        currentAmountUsdc: new Decimal('2250.500000'),
      }),
    ] as any)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.liabilityEstimate.isFullyFunded).toBe(true)
    expect(body.liabilityEstimate.shortfallUsdc).toBe('0.000000')
    expect(body.liabilityEstimate.surplusUsdc).toBe('250.500000')
    expect(body.liabilityEstimate.fundingProgressPercent).toBe(100)
    expect(body.liabilityEstimate.earlyWithdrawalPenalty.applies).toBe(false)

    vi.mocked(verifyAuthToken).mockResolvedValueOnce(null as any)
    const unauthRes = await GET(makeRequest(''))
    expect(unauthRes.status).toBe(401)
  })
})
