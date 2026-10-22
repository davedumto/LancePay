import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PATCH } from './route'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    savingsGoal: {
      findFirst: vi.fn(),
      update: vi.fn(),
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

const baseGoal = {
  id: 'goal-1',
  userId: 'user-1',
  title: 'Emergency Fund',
  targetAmountUsdc: new Decimal('1000.000000'),
  currentAmountUsdc: new Decimal('250.000000'),
  savingsPercentage: 10,
  isActive: true,
  status: 'in_progress',
  isTaxVault: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

function makePatchRequest(goalId = 'goal-1', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/savings-goals/${goalId}/pause`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireWalletActor).mockResolvedValue({ actor: mockActor } as any)
  vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValue(baseGoal as any)
  vi.mocked(prisma.savingsGoal.update).mockImplementation(async ({ data }: any) => ({
    ...baseGoal,
    isActive: data.isActive,
    updatedAt: new Date(),
  }))
})

describe('PATCH /api/savings-goals/[id]/pause', () => {
  it('toggles isActive from true to false (pausing automatic allocation)', async () => {
    const req = makePatchRequest('goal-1')
    const res = await PATCH(req, { params: Promise.resolve({ id: 'goal-1' }) })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.action).toBe('pause')
    expect(json.goal.isActive).toBe(false)
    expect(json.activeAllocationCounted).toBe(false)
    expect(json.actionTimestamp).toBeDefined()

    expect(prisma.savingsGoal.update).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { isActive: false },
      select: expect.any(Object),
    })
  })

  it('resumes a paused goal when toggled again or explicitly set to active', async () => {
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValue({
      ...baseGoal,
      isActive: false,
    } as any)

    const req = makePatchRequest('goal-1', { isActive: true })
    const res = await PATCH(req, { params: Promise.resolve({ id: 'goal-1' }) })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.action).toBe('resume')
    expect(json.goal.isActive).toBe(true)
    expect(json.activeAllocationCounted).toBe(true)
  })

  it('rejects pausing a goal that is already completed', async () => {
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValue({
      ...baseGoal,
      status: 'completed',
    } as any)

    const req = makePatchRequest('goal-1')
    const res = await PATCH(req, { params: Promise.resolve({ id: 'goal-1' }) })

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Cannot toggle pause state on a goal that is completed/i)
    expect(json.code).toBe('INVALID_GOAL_STATUS')
  })

  it('rejects pausing a goal that is already withdrawn', async () => {
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValue({
      ...baseGoal,
      status: 'withdrawn',
    } as any)

    const req = makePatchRequest('goal-1')
    const res = await PATCH(req, { params: Promise.resolve({ id: 'goal-1' }) })

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Cannot toggle pause state on a goal that is withdrawn/i)
  })

  it('returns 404 if the goal does not exist or is not owned by the user', async () => {
    vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValue(null)

    const req = makePatchRequest('non-existent')
    const res = await PATCH(req, { params: Promise.resolve({ id: 'non-existent' }) })

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.code).toBe('GOAL_NOT_FOUND')
  })
})
