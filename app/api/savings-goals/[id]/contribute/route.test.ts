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
    currentAmountUsdc: new Decimal('400'),
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
  return new NextRequest('http://localhost/api/savings-goals/goal-1/contribute', {
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

describe('POST /api/savings-goals/[id]/contribute', () => {
  it('atomically increments currentAmountUsdc on an active, in-progress goal', async () => {
    vi.mocked(prisma.savingsGoal.findUniqueOrThrow).mockResolvedValue(
      makeGoal({ currentAmountUsdc: new Decimal('650.25') }) as any
    )

    const res = await POST(makeRequest({ amountUsdc: '250.25' }), { params })

    expect(res.status).toBe(200)
    const args = vi.mocked(prisma.savingsGoal.updateMany).mock.calls[0][0] as any
    expect(args.where).toEqual({ id: 'goal-1', userId: 'user-1', isActive: true, status: 'in_progress' })
    expect(args.data.currentAmountUsdc.increment.toFixed(2)).toBe('250.25')
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.savingsGoal.update).not.toHaveBeenCalled()

    const body = await res.json()
    expect(body.completed).toBe(false)
    expect(body.goal.currentAmountUsdc).toBe('650.250000')
    expect(body.contribution.amountUsdc).toBe('250.250000')
  })

  it('transitions to completed when the contribution reaches the target exactly', async () => {
    vi.mocked(prisma.savingsGoal.findUniqueOrThrow).mockResolvedValue(
      makeGoal({ currentAmountUsdc: new Decimal('1000') }) as any
    )
    vi.mocked(prisma.savingsGoal.update).mockResolvedValue(
      makeGoal({ currentAmountUsdc: new Decimal('1000'), status: 'completed' }) as any
    )

    const res = await POST(makeRequest({ amountUsdc: 600 }), { params })

    expect(res.status).toBe(200)
    expect(prisma.savingsGoal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'goal-1' }, data: { status: 'completed' } })
    )
    const body = await res.json()
    expect(body.completed).toBe(true)
    expect(body.goal.status).toBe('completed')
  })

  it('transitions to completed when the contribution exceeds the target', async () => {
    vi.mocked(prisma.savingsGoal.findUniqueOrThrow).mockResolvedValue(
      makeGoal({ currentAmountUsdc: new Decimal('1200') }) as any
    )
    vi.mocked(prisma.savingsGoal.update).mockResolvedValue(makeGoal({ status: 'completed' }) as any)

    const res = await POST(makeRequest({ amountUsdc: 800 }), { params })

    expect((await res.json()).completed).toBe(true)
  })

  it('rejects contributions to an inactive goal with 409', async () => {
    vi.mocked(prisma.savingsGoal.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValue(makeGoal({ isActive: false }) as any)

    const res = await POST(makeRequest({ amountUsdc: 10 }), { params })

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('GOAL_INACTIVE')
    expect(prisma.savingsGoal.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it('rejects contributions to a goal that is no longer in progress', async () => {
    vi.mocked(prisma.savingsGoal.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValue(makeGoal({ status: 'completed' }) as any)

    const res = await POST(makeRequest({ amountUsdc: 10 }), { params })

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('GOAL_NOT_IN_PROGRESS')
  })

  it("returns 404 for a missing goal or another user's goal", async () => {
    vi.mocked(prisma.savingsGoal.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValue(null)

    const res = await POST(makeRequest({ amountUsdc: 10 }), { params })

    expect(res.status).toBe(404)
    const lookup = vi.mocked(prisma.savingsGoal.findFirst).mock.calls[0][0] as any
    expect(lookup.where).toEqual({ id: 'goal-1', userId: 'user-1' })
  })

  it.each([0, -1, '0.0000001', 'ten', null])('rejects amountUsdc %s', async (amountUsdc) => {
    const res = await POST(makeRequest({ amountUsdc }), { params })
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON', async () => {
    const res = await POST(makeRequest(undefined, '{bad'), { params })
    expect(res.status).toBe(400)
  })

  it('maps the 50% active savings trigger to 422', async () => {
    vi.mocked(prisma.savingsGoal.updateMany).mockRejectedValue(
      new Error('Total active savings cannot exceed 50%')
    )
    const res = await POST(makeRequest({ amountUsdc: 10 }), { params })
    expect(res.status).toBe(422)
  })

  it('returns 401 without a valid token', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makeRequest({ amountUsdc: 10 }), { params })
    expect(res.status).toBe(401)
  })
})
