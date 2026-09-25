import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    accountDeletionRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { DELETE } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const GRACE_END = new Date('2026-10-25T12:00:00.000Z')

function makeRequest(headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest('http://localhost/api/account-deletion-requests/del-1', { method: 'DELETE', headers })
}

function ctx(id = 'del-1') {
  return { params: Promise.resolve({ id }) }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    status: 'pending',
    reason: null,
    scheduledAt: GRACE_END,
    cancelledAt: null,
    completedAt: null,
    createdAt: new Date('2026-09-25T12:00:00.000Z'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.accountDeletionRequest.findFirst).mockResolvedValue(row() as never)
  vi.mocked(prisma.accountDeletionRequest.updateMany).mockResolvedValue({ count: 1 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DELETE /api/account-deletion-requests/[id]', () => {
  it('cancels a pending request and returns the remaining grace period', async () => {
    const res = await DELETE(makeRequest(), ctx())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.remainingGraceSeconds).toBe(20 * 24 * 60 * 60)
    expect(body.graceEndsAt).toBe(GRACE_END.toISOString())
    expect(body.deletionRequest).toMatchObject({
      id: 'del-1',
      status: 'cancelled',
      cancelledAt: NOW.toISOString(),
      cancellable: false,
    })
  })

  it('cancels with an atomic update conditioned on owner, status and grace period', async () => {
    await DELETE(makeRequest(), ctx())

    expect(prisma.accountDeletionRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 'del-1', userId: 'user-1' },
      select: expect.any(Object),
    })
    expect(prisma.accountDeletionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'del-1', userId: 'user-1', status: 'pending', scheduledAt: { gt: NOW } },
      data: { status: 'cancelled', cancelledAt: NOW },
    })
  })

  it('returns 401 without a bearer token', async () => {
    const res = await DELETE(makeRequest({}), ctx())
    expect(res.status).toBe(401)
    expect(prisma.accountDeletionRequest.updateMany).not.toHaveBeenCalled()
  })

  it('returns 401 for an invalid token', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(401)
  })

  it('returns 404 for a request owned by another user without revealing it', async () => {
    vi.mocked(prisma.accountDeletionRequest.findFirst).mockResolvedValue(null)

    const res = await DELETE(makeRequest(), ctx('someone-elses-request'))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Deletion request not found' })
    expect(prisma.accountDeletionRequest.updateMany).not.toHaveBeenCalled()
  })

  it('returns 404 for a nonexistent request', async () => {
    vi.mocked(prisma.accountDeletionRequest.findFirst).mockResolvedValue(null)
    const res = await DELETE(makeRequest(), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('returns 409 when the request is already cancelled', async () => {
    vi.mocked(prisma.accountDeletionRequest.findFirst).mockResolvedValue(
      row({ status: 'cancelled', cancelledAt: new Date('2026-10-01T00:00:00Z') }) as never,
    )
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already cancelled/)
    expect(prisma.accountDeletionRequest.updateMany).not.toHaveBeenCalled()
  })

  it('returns 409 when deletion processing has already begun', async () => {
    vi.mocked(prisma.accountDeletionRequest.findFirst).mockResolvedValue(
      row({ status: 'completed', completedAt: NOW }) as never,
    )
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/processing has already begun/)
    expect(prisma.accountDeletionRequest.updateMany).not.toHaveBeenCalled()
  })

  it('returns 409 once the grace period has elapsed', async () => {
    vi.setSystemTime(new Date('2026-10-25T12:00:00.001Z'))
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/grace period has elapsed/)
    expect(prisma.accountDeletionRequest.updateMany).not.toHaveBeenCalled()
  })

  it('treats the exact grace deadline as elapsed', async () => {
    vi.setSystemTime(GRACE_END)
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(409)
  })

  it('does not report success if the request changed state between read and update', async () => {
    vi.mocked(prisma.accountDeletionRequest.updateMany).mockResolvedValue({ count: 0 })

    const res = await DELETE(makeRequest(), ctx())

    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/changed state/)
  })

  it('returns a generic 500 on database failure', async () => {
    vi.mocked(prisma.accountDeletionRequest.updateMany).mockRejectedValue(new Error('deadlock detected'))
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('deadlock')
  })
})
