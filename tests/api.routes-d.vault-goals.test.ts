import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const goalFindMany = vi.fn()
const goalCreate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
    savingsGoal: {
      findMany: goalFindMany,
      create: goalCreate,
    },
  },
}))

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/vault/goals', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('GET /api/routes-d/vault/goals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the user is not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/vault/goals/route')
    const request = new NextRequest('http://localhost/api/routes-d/vault/goals')
    const response = await GET(request)

    expect(response.status).toBe(401)
    expect(goalFindMany).not.toHaveBeenCalled()
  })

  it('returns the user goals as serialized decimals', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    goalFindMany.mockResolvedValue([
      {
        id: 'goal_1',
        title: 'House',
        targetAmountUsdc: { toString: () => '50000.000000' },
        currentAmountUsdc: { toString: () => '1200.500000' },
        savingsPercentage: 15,
        isActive: true,
        status: 'in_progress',
        isTaxVault: false,
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      },
    ])

    const { GET } = await import('@/app/api/routes-d/vault/goals/route')
    const request = new NextRequest('http://localhost/api/routes-d/vault/goals')
    const response = await GET(request)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.goals).toHaveLength(1)
    expect(body.goals[0].targetAmountUsdc).toBe('50000.000000')
    expect(body.goals[0].currentAmountUsdc).toBe('1200.500000')

    expect(goalFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_1' } }),
    )
  })
})

describe('POST /api/routes-d/vault/goals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the user is not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { POST } = await import('@/app/api/routes-d/vault/goals/route')
    const response = await POST(postRequest({}))

    expect(response.status).toBe(401)
    expect(goalCreate).not.toHaveBeenCalled()
  })

  it('rejects a missing title', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-d/vault/goals/route')
    const response = await POST(postRequest({ targetAmountUsdc: '100', savingsPercentage: 10 }))

    expect(response.status).toBe(400)
    expect(goalCreate).not.toHaveBeenCalled()
  })

  it('rejects an invalid amount string', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-d/vault/goals/route')
    const response = await POST(
      postRequest({ title: 'House', targetAmountUsdc: '-10', savingsPercentage: 10 }),
    )

    expect(response.status).toBe(400)
    expect(goalCreate).not.toHaveBeenCalled()
  })

  it('rejects a percentage outside 0..100', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-d/vault/goals/route')
    const response = await POST(
      postRequest({ title: 'House', targetAmountUsdc: '100', savingsPercentage: 101 }),
    )

    expect(response.status).toBe(400)
    expect(goalCreate).not.toHaveBeenCalled()
  })

  it('creates a valid goal and echoes the persisted record', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    goalCreate.mockResolvedValue({
      id: 'goal_1',
      title: 'House',
      targetAmountUsdc: { toString: () => '5000.000000' },
      currentAmountUsdc: { toString: () => '0' },
      savingsPercentage: 15,
      isActive: true,
      status: 'in_progress',
      isTaxVault: false,
      createdAt: new Date('2026-06-23T00:00:00Z'),
      updatedAt: new Date('2026-06-23T00:00:00Z'),
    })

    const { POST } = await import('@/app/api/routes-d/vault/goals/route')
    const response = await POST(
      postRequest({
        title: 'House',
        targetAmountUsdc: '5000',
        savingsPercentage: 15,
      }),
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.id).toBe('goal_1')
    expect(body.title).toBe('House')
    expect(body.targetAmountUsdc).toBe('5000.000000')
    expect(body.savingsPercentage).toBe(15)
    expect(goalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          title: 'House',
          targetAmountUsdc: '5000',
          savingsPercentage: 15,
          isTaxVault: false,
        }),
      }),
    )
  })
})
