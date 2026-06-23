import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const savingsGoalFindUnique = vi.fn()
const savingsGoalUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    savingsGoal: { findUnique: savingsGoalFindUnique, update: savingsGoalUpdate },
  },
}))

function makeRequest(body: unknown, opts?: { auth?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = opts?.auth ?? 'Bearer token'
  if (auth) headers.authorization = auth
  return new NextRequest('http://localhost/api/routes-d/vault/goals/g_1', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
}

const ctx = { params: Promise.resolve({ id: 'g_1' }) }

describe('PATCH /api/routes-d/vault/goals/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth is supplied', async () => {
    const { PATCH } = await import('@/app/api/routes-d/vault/goals/[id]/route')
    const res = await PATCH(makeRequest({ title: 'x' }, { auth: '' }), ctx)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the goal does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savingsGoalFindUnique.mockResolvedValue(null)
    const { PATCH } = await import('@/app/api/routes-d/vault/goals/[id]/route')
    const res = await PATCH(makeRequest({ title: 'x' }), ctx)
    expect(res.status).toBe(404)
  })

  it('returns 403 when the goal belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savingsGoalFindUnique.mockResolvedValue({ id: 'g_1', userId: 'someone_else' })
    const { PATCH } = await import('@/app/api/routes-d/vault/goals/[id]/route')
    const res = await PATCH(makeRequest({ title: 'x' }), ctx)
    expect(res.status).toBe(403)
    expect(savingsGoalUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 for empty title', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savingsGoalFindUnique.mockResolvedValue({ id: 'g_1', userId: 'user_1' })
    const { PATCH } = await import('@/app/api/routes-d/vault/goals/[id]/route')
    const res = await PATCH(makeRequest({ title: '' }), ctx)
    expect(res.status).toBe(400)
  })

  it('returns 400 for non-positive targetAmountUsdc', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savingsGoalFindUnique.mockResolvedValue({ id: 'g_1', userId: 'user_1' })
    const { PATCH } = await import('@/app/api/routes-d/vault/goals/[id]/route')
    const res = await PATCH(makeRequest({ targetAmountUsdc: 0 }), ctx)
    expect(res.status).toBe(400)
  })

  it('returns 400 for savingsPercentage out of [0,100]', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savingsGoalFindUnique.mockResolvedValue({ id: 'g_1', userId: 'user_1' })
    const { PATCH } = await import('@/app/api/routes-d/vault/goals/[id]/route')
    const res = await PATCH(makeRequest({ savingsPercentage: 150 }), ctx)
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid status', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savingsGoalFindUnique.mockResolvedValue({ id: 'g_1', userId: 'user_1' })
    const { PATCH } = await import('@/app/api/routes-d/vault/goals/[id]/route')
    const res = await PATCH(makeRequest({ status: 'paused' }), ctx)
    expect(res.status).toBe(400)
  })

  it('returns 400 when no fields are supplied', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savingsGoalFindUnique.mockResolvedValue({ id: 'g_1', userId: 'user_1' })
    const { PATCH } = await import('@/app/api/routes-d/vault/goals/[id]/route')
    const res = await PATCH(makeRequest({}), ctx)
    expect(res.status).toBe(400)
  })

  it('updates and returns the goal on a valid body', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savingsGoalFindUnique.mockResolvedValue({ id: 'g_1', userId: 'user_1' })
    savingsGoalUpdate.mockResolvedValue({
      id: 'g_1',
      userId: 'user_1',
      title: 'New title',
      targetAmountUsdc: 500,
      currentAmountUsdc: 100,
      savingsPercentage: 25,
      isActive: true,
      status: 'in_progress',
      isTaxVault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const { PATCH } = await import('@/app/api/routes-d/vault/goals/[id]/route')
    const res = await PATCH(makeRequest({ title: 'New title', savingsPercentage: 25 }), ctx)
    expect(res.status).toBe(200)
    expect(savingsGoalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'g_1' },
        data: expect.objectContaining({ title: 'New title', savingsPercentage: 25 }),
      }),
    )
    const json = await res.json()
    expect(json.goal.targetAmountUsdc).toBe(500)
    expect(json.goal.currentAmountUsdc).toBe(100)
  })
})
