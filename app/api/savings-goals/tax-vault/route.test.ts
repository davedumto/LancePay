import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    savingsGoal: {
      findMany: vi.fn(),
    },
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))
vi.mock('@/app/api/_lib/collective-wallet-auth', () => ({
  requireWalletActor: vi.fn(),
}))

import { prisma } from '@/lib/db'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'

const mockActor = { id: 'user-1' }

const baseTaxGoal = {
  id: 'goal-tax-1',
  userId: 'user-1',
  title: 'Tax Vault 2026',
  targetAmountUsdc: new Decimal('10000.000000'),
  currentAmountUsdc: new Decimal('3500.000000'),
  savingsPercentage: 15,
  isActive: true,
  status: 'in_progress',
  isTaxVault: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost/api/savings-goals/tax-vault', {
    method: 'GET',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireWalletActor).mockResolvedValue({ actor: mockActor } as any)
  vi.mocked(prisma.savingsGoal.findMany).mockResolvedValue([baseTaxGoal] as any)
})

describe('GET /api/savings-goals/tax-vault', () => {
  it('returns the tax vault goal and projected liability metrics', async () => {
    const res = await GET(makeGetRequest())
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.goal.id).toBe('goal-tax-1')
    expect(json.goal.isTaxVault).toBe(true)
    expect(json.projectedLiability).toEqual({
      projectedLiabilityUsdc: '10000.000000',
      currentAmountUsdc: '3500.000000',
      remainingLiabilityUsdc: '6500.000000',
      fundingPercentage: 35,
      isFullyFunded: false,
    })
    expect(json.hasMultipleTaxVaults).toBe(false)
  })

  it('calculates 100% funding and zero remaining liability when goal is met', async () => {
    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValue([
      {
        ...baseTaxGoal,
        targetAmountUsdc: new Decimal('5000.000000'),
        currentAmountUsdc: new Decimal('5200.000000'),
      },
    ] as any)

    const res = await GET(makeGetRequest())
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.projectedLiability.remainingLiabilityUsdc).toBe('0.000000')
    expect(json.projectedLiability.fundingPercentage).toBe(100)
    expect(json.projectedLiability.isFullyFunded).toBe(true)
  })

  it('returns 404 when no tax vault goal exists for the user', async () => {
    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValue([])

    const res = await GET(makeGetRequest())
    expect(res.status).toBe(404)

    const json = await res.json()
    expect(json.code).toBe('TAX_VAULT_NOT_FOUND')
    expect(json.error).toMatch(/No tax vault goal configured/i)
  })

  it('defensively handles multiple tax vault goals and flags hasMultipleTaxVaults', async () => {
    const secondTaxGoal = {
      ...baseTaxGoal,
      id: 'goal-tax-2',
      title: 'Old Tax Vault',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    }

    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValue([baseTaxGoal, secondTaxGoal] as any)

    const res = await GET(makeGetRequest())
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.goal.id).toBe('goal-tax-1')
    expect(json.hasMultipleTaxVaults).toBe(true)
    expect(json.totalTaxVaultCount).toBe(2)
  })
})
