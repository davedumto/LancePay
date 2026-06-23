import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const withdrawalFindUnique = vi.fn()
const withdrawalUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    withdrawalTransaction: { findUnique: withdrawalFindUnique, update: withdrawalUpdate },
  },
}))

function makeRequest(opts?: { auth?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = opts?.auth ?? 'Bearer token'
  if (auth) headers.authorization = auth
  return new NextRequest('http://localhost/api/routes-d/withdrawals/wd_1/cancel', {
    method: 'POST',
    headers,
  })
}

const ctx = { params: Promise.resolve({ id: 'wd_1' }) }

describe('POST /api/routes-d/withdrawals/[id]/cancel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth is supplied', async () => {
    const { POST } = await import('@/app/api/routes-d/withdrawals/[id]/cancel/route')
    const res = await POST(makeRequest({ auth: '' }), ctx)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the withdrawal does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    withdrawalFindUnique.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/withdrawals/[id]/cancel/route')
    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(404)
  })

  it('returns 403 when the withdrawal belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    withdrawalFindUnique.mockResolvedValue({ id: 'wd_1', userId: 'someone_else', status: 'pending' })
    const { POST } = await import('@/app/api/routes-d/withdrawals/[id]/cancel/route')
    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(403)
    expect(withdrawalUpdate).not.toHaveBeenCalled()
  })

  it('returns 409 when the withdrawal is in a non-cancellable status', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    withdrawalFindUnique.mockResolvedValue({ id: 'wd_1', userId: 'user_1', status: 'completed' })
    const { POST } = await import('@/app/api/routes-d/withdrawals/[id]/cancel/route')
    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(409)
    expect(withdrawalUpdate).not.toHaveBeenCalled()
  })

  it('cancels a pending withdrawal and returns 200', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    withdrawalFindUnique.mockResolvedValue({ id: 'wd_1', userId: 'user_1', status: 'pending' })
    withdrawalUpdate.mockResolvedValue({
      id: 'wd_1',
      status: 'cancelled',
      amount: 100,
      asset: 'USDC',
      completedAt: new Date('2025-06-23'),
    })
    const { POST } = await import('@/app/api/routes-d/withdrawals/[id]/cancel/route')
    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(200)
    expect(withdrawalUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wd_1' },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    )
    const json = await res.json()
    expect(json.withdrawal.status).toBe('cancelled')
    expect(json.withdrawal.amount).toBe(100)
  })

  it('also cancels an interactive withdrawal (still cancellable)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    withdrawalFindUnique.mockResolvedValue({ id: 'wd_1', userId: 'user_1', status: 'interactive' })
    withdrawalUpdate.mockResolvedValue({ id: 'wd_1', status: 'cancelled', amount: 50, asset: 'USDC' })
    const { POST } = await import('@/app/api/routes-d/withdrawals/[id]/cancel/route')
    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(200)
  })
})
