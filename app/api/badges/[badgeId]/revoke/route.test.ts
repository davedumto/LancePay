import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DELETE } from './route'

vi.mock('@/lib/db', () => {
  const tx = {
    userBadge: { delete: vi.fn() },
    userBadgeRevocation: { create: vi.fn() },
  }
  return {
    prisma: {
      user: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const tx = (prisma as any).__tx
const ADMIN = '99999999-9999-4999-8999-999999999999'
const HOLDER = '11111111-1111-4111-8111-111111111111'
const BADGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SYSTEM_SECRET = 'system-secret-value'
const issuedAt = new Date('2026-01-01T00:00:00Z')

function request(body: unknown = { userId: HOLDER, reason: 'Lost dispute on INV-42' }, token = 'admin-token') {
  return new NextRequest(`http://localhost/api/badges/${BADGE}/revoke`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const context = (badgeId = BADGE) => ({ params: Promise.resolve({ badgeId }) })
const notFound = () => Object.assign(new Error('No record was found for a delete.'), { code: 'P2025' })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.BADGE_SYSTEM_SECRET = SYSTEM_SECRET
  vi.mocked(verifyAuthToken).mockImplementation((async (token: string) =>
    token === 'admin-token' ? { userId: 'privy-admin' } : token === 'user-token' ? { userId: 'privy-user' } : null) as any)
  vi.mocked(prisma.user.findUnique).mockImplementation((async (args: any) =>
    args.where.privyId === 'privy-admin'
      ? { id: ADMIN, role: 'admin' }
      : args.where.privyId === 'privy-user'
        ? { id: HOLDER, role: 'freelancer' }
        : null) as any)
  tx.userBadge.delete.mockResolvedValue({
    id: 'ub-1',
    userId: HOLDER,
    badgeId: BADGE,
    stellarTxHash: 'abc123',
    issuedAt,
  })
  tx.userBadgeRevocation.create.mockImplementation(async (args: any) => ({
    id: 'rev-1',
    revokedAt: new Date(),
    ...args.data,
  }))
})

describe('DELETE /api/badges/[badgeId]/revoke', () => {
  it('lets an admin revoke a held badge and records the reason with an audit snapshot', async () => {
    const response = await DELETE(request(), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(
      expect.objectContaining({ revoked: true, userId: HOLDER, badgeId: BADGE, trigger: 'admin', reason: 'Lost dispute on INV-42' }),
    )
    expect(tx.userBadge.delete).toHaveBeenCalledWith({
      where: { userId_badgeId: { userId: HOLDER, badgeId: BADGE } },
    })
    expect(tx.userBadgeRevocation.create).toHaveBeenCalledWith({
      data: {
        userBadgeId: 'ub-1',
        userId: HOLDER,
        badgeId: BADGE,
        stellarTxHash: 'abc123',
        issuedAt,
        trigger: 'admin',
        reason: 'Lost dispute on INV-42',
        revokedById: ADMIN,
      },
    })
  })

  it('lets a trusted system job revoke with a documented trigger', async () => {
    const response = await DELETE(
      request({ userId: HOLDER, reason: 'Dispute DSP-7 resolved for client', trigger: 'dispute_lost' }, SYSTEM_SECRET),
      context(),
    )

    expect(response.status).toBe(200)
    expect(tx.userBadgeRevocation.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ trigger: 'dispute_lost', revokedById: null }),
    )
    expect(verifyAuthToken).not.toHaveBeenCalled()
  })

  it('requires a documented trigger from system callers', async () => {
    const missing = await DELETE(request({ userId: HOLDER, reason: 'x' }, SYSTEM_SECRET), context())
    const unknown = await DELETE(request({ userId: HOLDER, reason: 'x', trigger: 'because' }, SYSTEM_SECRET), context())
    expect(missing.status).toBe(400)
    expect(unknown.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('forbids ordinary users, even when they claim a system trigger', async () => {
    const plain = await DELETE(request(undefined, 'user-token'), context())
    const spoofed = await DELETE(
      request({ userId: HOLDER, reason: 'x', trigger: 'dispute_lost' }, 'user-token'),
      context(),
    )
    expect(plain.status).toBe(403)
    expect(spoofed.status).toBe(403)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('does not treat a wrong or unset system secret as system access', async () => {
    expect((await DELETE(request(undefined, 'wrong-secret'), context())).status).toBe(401)

    delete process.env.BADGE_SYSTEM_SECRET
    expect((await DELETE(request(undefined, SYSTEM_SECRET), context())).status).toBe(401)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests', async () => {
    const noAuth = new NextRequest(`http://localhost/api/badges/${BADGE}/revoke`, { method: 'DELETE' })
    expect((await DELETE(noAuth, context())).status).toBe(401)
  })

  it('does not let admins pass a system trigger', async () => {
    const response = await DELETE(request({ userId: HOLDER, reason: 'x', trigger: 'fraud_review' }), context())
    expect(response.status).toBe(400)
  })

  it('returns 404 when the user does not hold the badge', async () => {
    tx.userBadge.delete.mockRejectedValue(notFound())

    const response = await DELETE(request(), context())

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'User does not hold this badge' })
    expect(tx.userBadgeRevocation.create).not.toHaveBeenCalled()
  })

  it('scopes the lookup to the named holder so another user badge is never touched', async () => {
    const otherUser = '22222222-2222-4222-8222-222222222222'
    tx.userBadge.delete.mockRejectedValue(notFound())

    const response = await DELETE(request({ userId: otherUser, reason: 'x' }), context())

    expect(response.status).toBe(404)
    expect(tx.userBadge.delete).toHaveBeenCalledWith({
      where: { userId_badgeId: { userId: otherUser, badgeId: BADGE } },
    })
  })

  it('is deterministic on repeat: the second revocation of the same badge is a 404', async () => {
    tx.userBadge.delete
      .mockResolvedValueOnce({ id: 'ub-1', userId: HOLDER, badgeId: BADGE, stellarTxHash: null, issuedAt })
      .mockRejectedValueOnce(notFound())

    const [first, second] = await Promise.all([DELETE(request(), context()), DELETE(request(), context())])

    expect([first.status, second.status].sort()).toEqual([200, 404])
    expect(tx.userBadgeRevocation.create).toHaveBeenCalledTimes(1)
  })

  it('validates the reason, user id and badge id', async () => {
    expect((await DELETE(request({ userId: HOLDER, reason: '   ' }), context())).status).toBe(400)
    expect((await DELETE(request({ userId: HOLDER }), context())).status).toBe(400)
    expect((await DELETE(request({ userId: HOLDER, reason: 'x'.repeat(501) }), context())).status).toBe(400)
    expect((await DELETE(request({ userId: 'nope', reason: 'x' }), context())).status).toBe(400)
    expect((await DELETE(request(), context('not-a-uuid'))).status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('returns 500, not 404, when the database fails', async () => {
    tx.userBadge.delete.mockRejectedValue(new Error('connection refused'))

    const response = await DELETE(request(), context())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to revoke badge' })
  })
})
