import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    savingsGoal: { findMany: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const actor = { id: 'user-1', email: 'saver@example.com' }

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'goal-1',
    title: 'Emergency fund',
    targetAmountUsdc: new Decimal('1000'),
    currentAmountUsdc: new Decimal('0'),
    savingsPercentage: 10,
    isActive: true,
    status: 'in_progress',
    isTaxVault: false,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  }
}

function makePost(body?: unknown, raw?: string): NextRequest {
  return new NextRequest('http://localhost/api/savings-goals', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
}

function makeGet(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/savings-goals${query}`, {
    headers: { authorization: 'Bearer token' },
  })
}

function createArgs() {
  return vi.mocked(prisma.savingsGoal.create).mock.calls[0][0] as any
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
  vi.mocked(prisma.savingsGoal.create).mockImplementation(
    (async (args: any) => makeGoal({ ...args.data, id: 'goal-new' })) as any
  )
})

describe('POST /api/savings-goals', () => {
  it('creates a goal defaulting isActive to true and status to in_progress', async () => {
    const res = await POST(makePost({ title: 'Laptop', targetAmountUsdc: '1500.50', savingsPercentage: 20 }))

    expect(res.status).toBe(201)
    const data = createArgs().data
    expect(data.userId).toBe('user-1')
    expect(data.isActive).toBe(true)
    expect(data.status).toBe('in_progress')
    expect(data.isTaxVault).toBe(false)
    expect(data.targetAmountUsdc.toFixed(6)).toBe('1500.500000')
    expect(data.currentAmountUsdc.toFixed(6)).toBe('0.000000')

    const body = await res.json()
    expect(body.goal.targetAmountUsdc).toBe('1500.500000')
    expect(body.goal.status).toBe('in_progress')
  })

  it('accepts a currentAmountUsdc below the target and isTaxVault', async () => {
    const res = await POST(
      makePost({ title: 'Taxes', targetAmountUsdc: 500, currentAmountUsdc: 100, savingsPercentage: 15, isTaxVault: true })
    )

    expect(res.status).toBe(201)
    const data = createArgs().data
    expect(data.currentAmountUsdc.toFixed(2)).toBe('100.00')
    expect(data.isTaxVault).toBe(true)
  })

  it.each([0, 101, 12.5])('rejects savingsPercentage %s', async (savingsPercentage) => {
    const res = await POST(makePost({ title: 'Goal', targetAmountUsdc: 100, savingsPercentage }))
    expect(res.status).toBe(400)
    expect(prisma.savingsGoal.create).not.toHaveBeenCalled()
  })

  it.each([0, -5, '1.1234567', 'abc'])('rejects targetAmountUsdc %s', async (targetAmountUsdc) => {
    const res = await POST(makePost({ title: 'Goal', targetAmountUsdc, savingsPercentage: 10 }))
    expect(res.status).toBe(400)
    expect(prisma.savingsGoal.create).not.toHaveBeenCalled()
  })

  it('rejects a targetAmountUsdc that is not greater than currentAmountUsdc', async () => {
    const res = await POST(
      makePost({ title: 'Goal', targetAmountUsdc: 100, currentAmountUsdc: 100, savingsPercentage: 10 })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/greater than currentAmountUsdc/)
  })

  it('rejects a negative currentAmountUsdc', async () => {
    const res = await POST(
      makePost({ title: 'Goal', targetAmountUsdc: 100, currentAmountUsdc: -1, savingsPercentage: 10 })
    )
    expect(res.status).toBe(400)
  })

  it('rejects a missing title and invalid JSON', async () => {
    expect((await POST(makePost({ targetAmountUsdc: 100, savingsPercentage: 10 }))).status).toBe(400)
    expect((await POST(makePost(undefined, '{bad'))).status).toBe(400)
  })

  it('maps the 50% active savings trigger to 422', async () => {
    vi.mocked(prisma.savingsGoal.create).mockRejectedValue(
      new Error('Raw query failed. Code: `P0001`. Message: `Total active savings cannot exceed 50%`')
    )
    const res = await POST(makePost({ title: 'Goal', targetAmountUsdc: 100, savingsPercentage: 40 }))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('SAVINGS_LIMIT_EXCEEDED')
  })

  it('returns 401 without a valid token', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makePost({ title: 'Goal', targetAmountUsdc: 100, savingsPercentage: 10 }))
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected errors', async () => {
    vi.mocked(prisma.savingsGoal.create).mockRejectedValue(new Error('db down'))
    const res = await POST(makePost({ title: 'Goal', targetAmountUsdc: 100, savingsPercentage: 10 }))
    expect(res.status).toBe(500)
  })
})

describe('GET /api/savings-goals', () => {
  it("lists only the caller's goals with serialized amounts", async () => {
    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValue([makeGoal()] as any)

    const res = await GET(makeGet())

    expect(res.status).toBe(200)
    const args = vi.mocked(prisma.savingsGoal.findMany).mock.calls[0][0] as any
    expect(args.where).toEqual({ userId: 'user-1' })
    const body = await res.json()
    expect(body.goals[0].targetAmountUsdc).toBe('1000.000000')
  })

  it('filters by status', async () => {
    vi.mocked(prisma.savingsGoal.findMany).mockResolvedValue([] as any)
    await GET(makeGet('?status=completed'))
    const args = vi.mocked(prisma.savingsGoal.findMany).mock.calls[0][0] as any
    expect(args.where).toEqual({ userId: 'user-1', status: 'completed' })
  })

  it('rejects an unknown status filter', async () => {
    const res = await GET(makeGet('?status=bogus'))
    expect(res.status).toBe(400)
  })

  it('returns 401 without a token', async () => {
    const res = await GET(new NextRequest('http://localhost/api/savings-goals'))
    expect(res.status).toBe(401)
  })
})
