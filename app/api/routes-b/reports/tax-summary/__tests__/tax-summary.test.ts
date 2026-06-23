import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findMany: vi.fn() },
    expense: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const txDelegate = prisma.transaction as unknown as { findMany: ReturnType<typeof vi.fn> }
const expenseDelegate = prisma.expense as unknown as { findMany: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-b/reports/tax-summary'

function makeGet(qs?: string, authHeader: string | null = 'Bearer token') {
  const url = qs ? `${BASE_URL}?${qs}` : BASE_URL
  return new NextRequest(url, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('GET /api/routes-b/reports/tax-summary', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet(undefined, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid year', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1', taxPercentage: 20 })
    const res = await GET(makeGet('year=abc'))
    expect(res.status).toBe(400)
  })

  it('returns zero summary when no transactions or expenses', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1', taxPercentage: 20 })
    txDelegate.findMany.mockResolvedValue([])
    expenseDelegate.findMany.mockResolvedValue([])
    const res = await GET(makeGet('year=2026'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.grossIncome).toBe(0)
    expect(body.totalExpenses).toBe(0)
    expect(body.estimatedTax).toBe(0)
    expect(body.year).toBe(2026)
  })

  it('calculates net income and estimated tax correctly', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1', taxPercentage: 25 })
    txDelegate.findMany.mockResolvedValue([
      { amount: 1000, currency: 'USDC' },
      { amount: 500, currency: 'USDC' },
    ])
    expenseDelegate.findMany.mockResolvedValue([{ amount: 200, currency: 'USDC' }])
    const res = await GET(makeGet('year=2026'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.grossIncome).toBe(1500)
    expect(body.totalExpenses).toBe(200)
    expect(body.netIncome).toBe(1300)
    expect(body.estimatedTax).toBe(325)
    expect(body.taxRate).toBe(25)
  })

  it('clamps estimated tax to zero when expenses exceed income', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1', taxPercentage: 20 })
    txDelegate.findMany.mockResolvedValue([{ amount: 100, currency: 'USDC' }])
    expenseDelegate.findMany.mockResolvedValue([{ amount: 500, currency: 'USDC' }])
    const res = await GET(makeGet('year=2026'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.estimatedTax).toBe(0)
    expect(body.netIncome).toBe(-400)
  })
})
