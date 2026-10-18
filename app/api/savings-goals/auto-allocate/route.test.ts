import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => {
  const prisma: Record<string, unknown> = {
    user: { findUnique: vi.fn() },
    savingsGoal: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  }
  prisma.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(prisma))
  return { prisma }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const actor = { id: 'user-1', email: 'saver@lancepay.io' }

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'goal-1',
    title: 'Tax Reserve',
    targetAmountUsdc: new Decimal('1000'),
    currentAmountUsdc: new Decimal('100'),
    savingsPercentage: 20,
    isActive: true,
    status: 'in_progress',
    isTaxVault: true,
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  }
}

function makeRequest(body?: unknown, token: string | null = 'valid-token'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/savings-goals/auto-allocate', {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/savings-goals/auto-allocate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as never)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(makeRequest({ amountUsdc: '500' }, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 when amountUsdc is invalid or non-positive', async () => {
    const resZero = await POST(makeRequest({ amountUsdc: 0 }))
    expect(resZero.status).toBe(400)

    const resNegative = await POST(makeRequest({ amountUsdc: '-50' }))
    expect(resNegative.status).toBe(400)
  })

  it('allocates exact percentages across active in_progress goals and transitions completed goals', async () => {
    const goal1 = makeGoal({
      id: 'goal-1',
      title: 'Tax Vault',
      savingsPercentage: 20,
      currentAmountUsdc: new Decimal('100'),
      targetAmountUsdc: new Decimal('1000'),
    })
    const goal2 = makeGoal({
      id: 'goal-2',
      title: 'Laptop Upgrade',
      savingsPercentage: 10,
      currentAmountUsdc: new Decimal('450'),
      targetAmountUsdc: new Decimal('500'),
    })

    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValueOnce([goal1, goal2] as never)

    // goal-1 gets 20% of 500 = 100 -> current 200 (< 1000)
    // goal-2 gets 10% of 500 = 50 -> current 500 (== 500 -> transitions to completed)
    vi.mocked(prisma.savingsGoal.update)
      .mockResolvedValueOnce({
        ...goal1,
        currentAmountUsdc: new Decimal('200'),
      } as never)
      .mockResolvedValueOnce({
        ...goal2,
        currentAmountUsdc: new Decimal('500'),
      } as never)
      .mockResolvedValueOnce({
        ...goal2,
        currentAmountUsdc: new Decimal('500'),
        status: 'completed',
      } as never)

    const res = await POST(makeRequest({ amountUsdc: '500' }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.scaled).toBe(false)
    expect(body.scalingRule).toBe('exact_percentage')
    expect(body.totalAllocatedUsdc).toBe('150.000000')
    expect(body.unallocatedRemainderUsdc).toBe('350.000000')
    expect(body.allocations).toHaveLength(2)
    expect(body.allocations[0]).toMatchObject({
      goalId: 'goal-1',
      allocatedAmountUsdc: '100.000000',
      completed: false,
    })
    expect(body.allocations[1]).toMatchObject({
      goalId: 'goal-2',
      allocatedAmountUsdc: '50.000000',
      completed: true,
    })

    expect(prisma.savingsGoal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          isActive: true,
          status: 'in_progress',
        },
      }),
    )
  })

  it('proportionally scales allocations when active goals sum to more than 100% so total never exceeds incoming amount', async () => {
    const goalA = makeGoal({
      id: 'goal-a',
      title: 'Goal A',
      savingsPercentage: 80,
      currentAmountUsdc: new Decimal('0'),
      targetAmountUsdc: new Decimal('5000'),
    })
    const goalB = makeGoal({
      id: 'goal-b',
      title: 'Goal B',
      savingsPercentage: 40,
      currentAmountUsdc: new Decimal('0'),
      targetAmountUsdc: new Decimal('5000'),
    })

    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValueOnce([goalA, goalB] as never)
    vi.mocked(prisma.savingsGoal.update)
      .mockImplementationOnce(async ({ data }: any) => ({
        ...goalA,
        currentAmountUsdc: data.currentAmountUsdc.increment,
      }) as never)
      .mockImplementationOnce(async ({ data }: any) => ({
        ...goalB,
        currentAmountUsdc: data.currentAmountUsdc.increment,
      }) as never)

    // Total percentage = 120% on 300 USDC:
    // Goal A (80/120) -> 200 USDC
    // Goal B (40/120) -> 100 USDC
    const res = await POST(makeRequest({ amountUsdc: '300' }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.scaled).toBe(true)
    expect(body.scalingRule).toBe('proportional_cap_100')
    expect(body.totalRequestedPercentage).toBe(120)
    expect(body.totalAllocatedUsdc).toBe('300.000000')
    expect(body.unallocatedRemainderUsdc).toBe('0.000000')
    expect(body.allocations[0].allocatedAmountUsdc).toBe('200.000000')
    expect(body.allocations[1].allocatedAmountUsdc).toBe('100.000000')
  })
})
