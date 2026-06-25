import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const deletionFindFirst = vi.fn()
const deletionCreate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
    accountDeletionRequest: {
      findFirst: deletionFindFirst,
      create: deletionCreate,
    },
  },
}))

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/routes-d/account/close', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/routes-d/account/close', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the user is not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const response = await POST(postRequest({}))

    expect(response.status).toBe(401)
    expect(deletionCreate).not.toHaveBeenCalled()
  })

  it('creates a pending request with a 30-day grace window', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    deletionFindFirst.mockResolvedValue(null)
    deletionCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'del_1',
      status: 'pending',
      scheduledAt: data.scheduledAt,
      createdAt: new Date('2026-06-23T00:00:00Z'),
    }))

    const before = Date.now()

    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const response = await POST(postRequest({ reason: 'Closing my account.' }))

    expect(response.status).toBe(202)
    const body = await response.json()
    expect(body.id).toBe('del_1')
    expect(body.status).toBe('pending')
    expect(body.graceDays).toBe(30)

    const scheduledAt = new Date(body.scheduledAt).getTime()
    const expectedLow = before + 30 * 24 * 60 * 60 * 1000 - 5_000
    const expectedHigh = before + 30 * 24 * 60 * 60 * 1000 + 5_000
    expect(scheduledAt).toBeGreaterThanOrEqual(expectedLow)
    expect(scheduledAt).toBeLessThanOrEqual(expectedHigh)
  })

  it('rejects a reason longer than 500 characters', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const response = await POST(postRequest({ reason: 'x'.repeat(501) }))

    expect(response.status).toBe(400)
    expect(deletionCreate).not.toHaveBeenCalled()
  })

  it('returns 409 when a pending request already exists', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    deletionFindFirst.mockResolvedValue({
      id: 'del_old',
      scheduledAt: new Date('2026-07-01T00:00:00Z'),
      createdAt: new Date('2026-06-01T00:00:00Z'),
    })

    const { POST } = await import('@/app/api/routes-d/account/close/route')
    const response = await POST(postRequest({ reason: 'Try again' }))

    expect(response.status).toBe(409)
    expect(deletionCreate).not.toHaveBeenCalled()
    const body = await response.json()
    expect(body.id).toBe('del_old')
    expect(body.status).toBe('pending')
  })
})
