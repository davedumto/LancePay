import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => {
  const prisma: any = {
    user: { findUnique: vi.fn() },
    savingsGoal: {
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
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

const actor = { id: 'user-1', email: 'saver@example.com' }
const params = Promise.resolve({ id: 'goal-1' })

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'goal-1',
    title: 'Emergency fund',
    targetAmountUsdc: new Decimal('1000'),
    currentAmountUsdc: new Decimal('300'),
    savingsPercentage: 10,
    isActive: true,
    status: 'in_progress',
    isTaxVault: false,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  }
}

function makeRequest(body?: unknown, raw?: string): NextRequest {
  return new NextRequest('http://localhost/api/savings-goals/goal-1/withdraw', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
  vi.mocked(prisma.savingsGoal.updateMany).mockResolvedValue({ count: 1 })
})

describe('POST /api/savings-goals/[id]/withdraw', () => {
  it('decrements with a balance guard and keeps status while funds remain', async () => {
    vi.mocked(prisma.savingsGoal.findUniqueOrThrow).mockResolvedValue(makeGoal() as any)

    const res = await POST(makeRequest({ amountUsdc: '200' }), { params })

    expect(res.status).toBe(200)
    const args = vi.mocked(prisma.savingsGoal.updateMany).mock.calls[0][0] as any
    expect(args.where.id).toBe('goal-1')
    expect(args.where.userId).toBe('user-1')
    expect(args.where.currentAmountUsdc.gte.toFixed(0)).toBe('200')
    expect(args.data.currentAmountUsdc.decrement.toFixed(0)).toBe('200')
    expect(prisma.savingsGoal.update).not.toHaveBeenCalled()

    const body = await res.json()
    expect(body.goal.status).toBe('in_progress')
    expect(body.withdrawal).toEqual({
      amountUsdc: '200.000000',
      earlyWithdrawalPenalty: { applied: false, percentage: 0, amountUsdc: '0.000000' },
      netAmountUsdc: '200.000000',
    })
  })

  it('sets status to withdrawn only when the balance reaches zero', async () => {
    vi.mocked(prisma.savingsGoal.findUniqueOrThrow).mockResolvedValue(
      makeGoal({ currentAmountUsdc: new Decimal('0') }) as any
    )
    vi.mocked(prisma.savingsGoal.update).mockResolvedValue(
      makeGoal({ currentAmountUsdc: new Decimal('0'), status: 'withdrawn' }) as any
    )

    const res = await POST(makeRequest({ amountUsdc: 300 }), { params })

    expect(res.status).toBe(200)
    expect(prisma.savingsGoal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'goal-1' }, data: { status: 'withdrawn' } })
    )
    expect((await res.json()).goal.status).toBe('withdrawn')
  })

  it('applies and discloses the early-withdrawal penalty for an in-progress tax vault', async () => {
    vi.mocked(prisma.savingsGoal.findUniqueOrThrow).mockResolvedValue(
      makeGoal({ isTaxVault: true, currentAmountUsdc: new Decimal('150') }) as any
    )

    const res = await POST(makeRequest({ amountUsdc: '150' }), { params })

    expect(res.status).toBe(200)
    const { withdrawal } = await res.json()
    expect(withdrawal.earlyWithdrawalPenalty).toEqual({ applied: true, percentage: 10, amountUsdc: '15.000000' })
    expect(withdrawal.netAmountUsdc).toBe('135.000000')
  })

  it('does not penalize a tax vault goal that is completed', async () => {
    vi.mocked(prisma.savingsGoal.findUniqueOrThrow).mockResolvedValue(
      makeGoal({ isTaxVault: true, status: 'completed', currentAmountUsdc: new Decimal('900') }) as any
    )

    const res = await POST(makeRequest({ amountUsdc: 100 }), { params })

    const { withdrawal } = await res.json()
    expect(withdrawal.earlyWithdrawalPenalty.applied).toBe(false)
    expect(withdrawal.netAmountUsdc).toBe('100.000000')
  })

  it('rounds the penalty to USDC precision', async () => {
    vi.mocked(prisma.savingsGoal.findUniqueOrThrow).mockResolvedValue(
      makeGoal({ isTaxVault: true }) as any
    )

    const res = await POST(makeRequest({ amountUsdc: '0.000005' }), { params })

    const { withdrawal } = await res.json()
    expect(withdrawal.earlyWithdrawalPenalty.amountUsdc).toBe('0.000001')
    expect(withdrawal.netAmountUsdc).toBe('0.000004')
  })

  it('rejects an amount greater than currentAmountUsdc with 422', async () => {
    vi.mocked(prisma.savingsGoal.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValue(makeGoal() as any)

    const res = await POST(makeRequest({ amountUsdc: 300.01 }), { params })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('INSUFFICIENT_GOAL_BALANCE')
    expect(body.details).toEqual({ requestedAmountUsdc: '300.010000', currentAmountUsdc: '300.000000' })
    expect(prisma.savingsGoal.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it("returns 404 for a missing goal or another user's goal", async () => {
    vi.mocked(prisma.savingsGoal.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValue(null)

    const res = await POST(makeRequest({ amountUsdc: 10 }), { params })

    expect(res.status).toBe(404)
  })

  it.each([0, -10, '1.0000001', 'all', undefined])('rejects amountUsdc %s', async (amountUsdc) => {
    const res = await POST(makeRequest({ amountUsdc }), { params })
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('returns 401 without a valid token', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makeRequest({ amountUsdc: 10 }), { params })
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected errors', async () => {
    vi.mocked(prisma.savingsGoal.updateMany).mockRejectedValue(new Error('db down'))
    const res = await POST(makeRequest({ amountUsdc: 10 }), { params })
    expect(res.status).toBe(500)
  })
})
