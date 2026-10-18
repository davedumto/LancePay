import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    savingsGoal: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { PATCH, computeAutoAllocations } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const actor = { id: 'user-1', email: 'saver@example.com' }
const params = Promise.resolve({ id: 'goal-1' })

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'goal-1',
    title: 'Hardware Upgrade Fund',
    targetAmountUsdc: new Decimal('2000.000000'),
    currentAmountUsdc: new Decimal('650.250000'),
    savingsPercentage: 15,
    isActive: true,
    status: 'in_progress',
    isTaxVault: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  }
}

function makeRequest(body?: unknown, rawBody?: string, authHeader = 'Bearer valid-token'): NextRequest {
  const headers: Record<string, string> = {}
  if (authHeader) headers.authorization = authHeader
  return new NextRequest('http://localhost/api/savings-goals/goal-1/pause', {
    method: 'PATCH',
    headers,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
})

describe('PATCH /api/savings-goals/[id]/pause', () => {
  it('toggles isActive to pause and resume without discarding currentAmountUsdc and records audit timestamps', async () => {
    // Pause an active goal
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValueOnce(makeGoal({ isActive: true }) as any)
    vi.mocked(prisma.savingsGoal.update).mockImplementationOnce((async ({ data }: any) =>
      makeGoal({ isActive: data.isActive, updatedAt: data.updatedAt })) as any)

    const pauseRes = await PATCH(makeRequest(), { params })
    expect(pauseRes.status).toBe(200)
    const pauseBody = await pauseRes.json()

    expect(pauseBody.goal.isActive).toBe(false)
    expect(pauseBody.goal.currentAmountUsdc).toBe('650.250000')
    expect(pauseBody.autoAllocationEligible).toBe(false)
    expect(pauseBody.audit.action).toBe('paused')
    expect(pauseBody.audit.previousIsActive).toBe(true)
    expect(pauseBody.audit.isActive).toBe(false)
    expect(typeof pauseBody.audit.pausedAt).toBe('string')
    expect(pauseBody.audit.resumedAt).toBeNull()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        goalId: 'goal-1',
        action: 'paused',
        currentAmountUsdc: '650.250000',
      }),
      'Savings goal auto-allocation paused'
    )

    // Resume the paused goal
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValueOnce(makeGoal({ isActive: false }) as any)
    vi.mocked(prisma.savingsGoal.update).mockImplementationOnce((async ({ data }: any) =>
      makeGoal({ isActive: data.isActive, updatedAt: data.updatedAt })) as any)

    const resumeRes = await PATCH(makeRequest({ isActive: true }), { params })
    expect(resumeRes.status).toBe(200)
    const resumeBody = await resumeRes.json()

    expect(resumeBody.goal.isActive).toBe(true)
    expect(resumeBody.goal.currentAmountUsdc).toBe('650.250000')
    expect(resumeBody.autoAllocationEligible).toBe(true)
    expect(resumeBody.audit.action).toBe('resumed')
    expect(resumeBody.audit.previousIsActive).toBe(false)
    expect(resumeBody.audit.isActive).toBe(true)
    expect(resumeBody.audit.pausedAt).toBeNull()
    expect(typeof resumeBody.audit.resumedAt).toBe('string')
  })

  it('excludes paused goals (isActive: false) from automatic percentage-based allocation and enforces 50% limit on resume', async () => {
    const activeGoal = makeGoal({ id: 'goal-active', isActive: true, savingsPercentage: 15 })
    const pausedGoal = makeGoal({ id: 'goal-paused', isActive: false, savingsPercentage: 20 })
    const completedGoal = makeGoal({
      id: 'goal-completed',
      isActive: true,
      status: 'completed',
      savingsPercentage: 10,
    })

    const result = computeAutoAllocations(
      [activeGoal, pausedGoal, completedGoal] as any,
      '1000.000000'
    )
    expect(result.allocations).toEqual([
      {
        goalId: 'goal-active',
        savingsPercentage: 15,
        allocatedAmountUsdc: '150.000000',
      },
    ])
    expect(result.totalAllocatedUsdc).toBe('150.000000')
    expect(result.excludedGoalIds).toEqual(['goal-paused', 'goal-completed'])

    // Resuming when active goals would exceed 50% returns 422 SAVINGS_LIMIT_EXCEEDED
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValueOnce(makeGoal({ isActive: false }) as any)
    vi.mocked(prisma.savingsGoal.update).mockRejectedValueOnce(
      new Error('Total active savings cannot exceed 50%')
    )

    const limitRes = await PATCH(makeRequest(), { params })
    expect(limitRes.status).toBe(422)
    const limitBody = await limitRes.json()
    expect(limitBody.code).toBe('SAVINGS_LIMIT_EXCEEDED')
  })

  it('rejects toggling isActive on a goal whose status is already completed or withdrawn with 409', async () => {
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValueOnce(
      makeGoal({ status: 'completed' }) as any
    )

    const completedRes = await PATCH(makeRequest(), { params })
    expect(completedRes.status).toBe(409)
    const completedBody = await completedRes.json()
    expect(completedBody.code).toBe('GOAL_NOT_IN_PROGRESS')
    expect(prisma.savingsGoal.update).not.toHaveBeenCalled()

    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValueOnce(
      makeGoal({ status: 'withdrawn' }) as any
    )

    const withdrawnRes = await PATCH(makeRequest(), { params })
    expect(withdrawnRes.status).toBe(409)
    const withdrawnBody = await withdrawnRes.json()
    expect(withdrawnBody.code).toBe('GOAL_NOT_IN_PROGRESS')
    expect(prisma.savingsGoal.update).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing goal, 400 for invalid/conflicting body, and 401 when unauthenticated', async () => {
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValueOnce(null)
    const notFoundRes = await PATCH(makeRequest(), { params })
    expect(notFoundRes.status).toBe(404)

    const conflictBodyRes = await PATCH(
      makeRequest({ isActive: true, paused: true }),
      { params }
    )
    expect(conflictBodyRes.status).toBe(400)

    vi.mocked(verifyAuthToken).mockResolvedValueOnce(null as any)
    const unauthRes = await PATCH(makeRequest(undefined, undefined, ''), { params })
    expect(unauthRes.status).toBe(401)
  })
})
