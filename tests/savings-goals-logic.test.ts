import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '@/app/api/routes-d/savings/goals/route'
import { PATCH } from '@/app/api/routes-d/savings/goals/[id]/route'
import { prisma } from '@/lib/db'
import { NextRequest } from 'next/server'

// Mock dependencies
vi.mock('@/lib/db', () => ({
  prisma: {
    savingsGoal: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('../app/api/routes-d/savings/_shared', async (importOriginal) => {
  const actual = await importOriginal() as any
  return {
    ...actual,
    getAuthContext: vi.fn().mockResolvedValue({
      user: { id: 'user-1' },
      claims: { userId: 'user-1' },
    }),
  }
})

describe('Savings Goals Percentage Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('POST /api/routes-d/savings/goals', () => {
    it('allows creating a goal if total remains <= 50%', async () => {
      vi.mocked(prisma.savingsGoal.findMany).mockResolvedValueOnce([
        { savingsPercentage: 20 } as any,
      ])
      vi.mocked(prisma.savingsGoal.create).mockResolvedValueOnce({
        id: 'goal-2',
        userId: 'user-1',
        title: 'Goal 2',
        targetAmountUsdc: 1000,
        currentAmountUsdc: 0,
        savingsPercentage: 30,
        isActive: true,
        status: 'in_progress',
        isTaxVault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      const req = new NextRequest('http://localhost:3000/api/routes-d/savings/goals', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Goal 2',
          targetAmount: 1000,
          savingsPercentage: 30,
        }),
      })

      const res = await POST(req)
      expect(res.status).toBe(201)
      expect(prisma.savingsGoal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', isActive: true, status: 'in_progress' },
        })
      )
    })

    it('rejects creating a goal if total would exceed 50%', async () => {
      vi.mocked(prisma.savingsGoal.findMany).mockResolvedValueOnce([
        { savingsPercentage: 30 } as any,
      ])

      const req = new NextRequest('http://localhost:3000/api/routes-d/savings/goals', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Goal 2',
          targetAmount: 1000,
          savingsPercentage: 25,
        }),
      })

      const res = await POST(req)
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toContain('Cannot exceed 50% total savings')
    })
  })

  describe('PATCH /api/routes-d/savings/goals/[id]', () => {
    it('rejects reactivation if it would exceed 50% limit', async () => {
      const existingGoal = {
        id: 'goal-1',
        userId: 'user-1',
        isActive: false,
        status: 'in_progress',
        savingsPercentage: 30,
      }

      vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValueOnce(existingGoal as any)
      vi.mocked(prisma.savingsGoal.findMany).mockResolvedValueOnce([
        { id: 'goal-2', savingsPercentage: 25 } as any,
      ])

      const req = new NextRequest('http://localhost:3000/api/routes-d/savings/goals/goal-1', {
        method: 'PATCH',
        body: JSON.stringify({ isActive: true }),
      })

      const res = await PATCH(req, { params: Promise.resolve({ id: 'goal-1' }) })
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toContain('Cannot exceed 50% total savings')
      
      // Verify query standardization
      expect(prisma.savingsGoal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            isActive: true,
            status: 'in_progress',
            id: { not: 'goal-1' },
          },
        })
      )
    })

    it('allows reactivation if total remains <= 50%', async () => {
      const existingGoal = {
        id: 'goal-1',
        userId: 'user-1',
        title: 'Goal 1',
        targetAmountUsdc: 500,
        currentAmountUsdc: 100,
        isActive: false,
        status: 'in_progress',
        savingsPercentage: 20,
        isTaxVault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      vi.mocked(prisma.savingsGoal.findFirst).mockResolvedValueOnce(existingGoal as any)
      vi.mocked(prisma.savingsGoal.findMany).mockResolvedValueOnce([
        { id: 'goal-2', savingsPercentage: 20 } as any,
      ])
      vi.mocked(prisma.savingsGoal.update).mockResolvedValueOnce({
        ...existingGoal,
        isActive: true,
        updatedAt: new Date(),
      } as any)

      const req = new NextRequest('http://localhost:3000/api/routes-d/savings/goals/goal-1', {
        method: 'PATCH',
        body: JSON.stringify({ isActive: true }),
      })

      const res = await PATCH(req, { params: Promise.resolve({ id: 'goal-1' }) })
      expect(res.status).toBe(200)
    })
  })
})
