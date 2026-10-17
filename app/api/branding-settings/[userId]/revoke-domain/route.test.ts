import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    brandingSettings: { updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function request(body: unknown = { revocationReason: 'Failed periodic re-verification' }, withAuth = true) {
  return new NextRequest('http://localhost/api/branding-settings/owner-1/revoke-domain', {
    method: 'POST',
    headers: {
      ...(withAuth ? { authorization: 'Bearer token' } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

const context = (userId = 'owner-1') => ({ params: Promise.resolve({ userId }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-owner' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'owner-1', role: 'freelancer' } as any)
  vi.mocked(prisma.brandingSettings.updateMany).mockResolvedValue({ count: 1 })
})

describe('POST /api/branding-settings/[userId]/revoke-domain', () => {
  it('atomically clears verified fields, restores the default sender, and persists the revocation audit fields', async () => {
    const response = await POST(request(), context())
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(prisma.brandingSettings.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'owner-1',
        customDomain: { not: null },
        verificationStatus: 'verified',
      },
      data: {
        customDomain: null,
        verificationToken: null,
        verificationStatus: 'unverified',
        verifiedAt: null,
        verificationAttempts: 0,
        senderDomain: 'lancepay.com',
        domainRevokedAt: expect.any(Date),
        domainRevocationReason: 'Failed periodic re-verification',
      },
    })
    expect(json).toMatchObject({
      userId: 'owner-1',
      senderDomain: 'lancepay.com',
      revocationReason: 'Failed periodic re-verification',
      domainRevocationReason: 'Failed periodic re-verification',
      verificationStatus: 'unverified',
      customDomain: null,
    })
    expect(typeof json.revokedAt).toBe('string')
  })

  it('allows an admin to revoke another user domain', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin-1', role: 'admin' } as any)
    expect((await POST(request(), context('owner-2'))).status).toBe(200)
  })

  it('rejects non-owners and unauthenticated requests', async () => {
    expect((await POST(request(), context('owner-2'))).status).toBe(403)
    expect((await POST(request({}, false), context())).status).toBe(401)
  })

  it('requires a non-empty revocation reason of at most 500 characters', async () => {
    expect((await POST(request({ revocationReason: '  ' }), context())).status).toBe(400)
    expect((await POST(request({ revocationReason: 'x'.repeat(501) }), context())).status).toBe(400)
  })

  it('returns 404 when no verified domain exists (e.g. unverified or pending)', async () => {
    vi.mocked(prisma.brandingSettings.updateMany).mockResolvedValue({ count: 0 })
    const res = await POST(request(), context())
    expect(res.status).toBe(404)
    expect(prisma.brandingSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          verificationStatus: 'verified',
        }),
      }),
    )
  })

  it('returns 500 when the atomic update fails', async () => {
    vi.mocked(prisma.brandingSettings.updateMany).mockRejectedValue(new Error('database unavailable'))
    expect((await POST(request(), context())).status).toBe(500)
  })
})
