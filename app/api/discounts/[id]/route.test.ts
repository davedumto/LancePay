import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    discount: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { GET, DELETE } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const NOW = new Date('2026-10-17T12:00:00.000Z')

function makeRequest(
  method: 'GET' | 'DELETE',
  id = 'disc-1',
  token: string | null = 'valid-token',
): NextRequest {
  return new NextRequest(`http://localhost/api/discounts/${id}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('GET & DELETE /api/discounts/[id] (#1677)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as any)
  })

  it('DELETE soft-deactivates an active discount (active=false) without hard-deleting it', async () => {
    vi.mocked(prisma.discount.findUnique).mockResolvedValue({
      id: 'disc-1',
      userId: 'user-1',
      code: 'LAUNCH20',
      type: 'percent',
      value: new Decimal('20.00'),
      active: true,
      maxRedemptions: 100,
      redemptions: 14,
      expiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as any)

    vi.mocked(prisma.discount.update).mockResolvedValue({
      id: 'disc-1',
      userId: 'user-1',
      code: 'LAUNCH20',
      type: 'percent',
      value: new Decimal('20.00'),
      active: false,
      maxRedemptions: 100,
      redemptions: 14,
      expiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as any)

    const res = await DELETE(makeRequest('DELETE', 'disc-1'), {
      params: Promise.resolve({ id: 'disc-1' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.discount.id).toBe('disc-1')
    expect(body.discount.active).toBe(false)
    expect(body.discount.value).toBe(20)
    expect(body.discount.redemptions).toBe(14)

    expect(prisma.discount.update).toHaveBeenCalledWith({
      where: { id: 'disc-1' },
      data: { active: false },
      select: expect.any(Object),
    })
    expect((prisma.discount as any).delete).not.toHaveBeenCalled()
  })

  it('DELETE rejects deactivating an already-inactive discount with 409 DISCOUNT_ALREADY_INACTIVE', async () => {
    vi.mocked(prisma.discount.findUnique).mockResolvedValue({
      id: 'disc-1',
      userId: 'user-1',
      code: 'EXPIRED10',
      type: 'percent',
      value: new Decimal('10.00'),
      active: false,
      maxRedemptions: null,
      redemptions: 3,
      expiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as any)

    const res = await DELETE(makeRequest('DELETE', 'disc-1'), {
      params: Promise.resolve({ id: 'disc-1' }),
    })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('DISCOUNT_ALREADY_INACTIVE')
    expect(prisma.discount.update).not.toHaveBeenCalled()
  })

  it('GET returns a single discount owned by the authenticated user', async () => {
    vi.mocked(prisma.discount.findUnique).mockResolvedValue({
      id: 'disc-1',
      userId: 'user-1',
      code: 'VIP50',
      type: 'fixed',
      value: new Decimal('50.00'),
      active: true,
      maxRedemptions: 5,
      redemptions: 1,
      expiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as any)

    const res = await GET(makeRequest('GET', 'disc-1'), {
      params: Promise.resolve({ id: 'disc-1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.discount.code).toBe('VIP50')
    expect(body.discount.value).toBe(50)
  })

  it("enforces owner-only access (403 for another user's discount, 404 when missing, 401 when unauthenticated)", async () => {
    vi.mocked(prisma.discount.findUnique).mockResolvedValueOnce({
      id: 'disc-other',
      userId: 'other-user-2',
      code: 'OTHER',
      type: 'percent',
      value: new Decimal('15.00'),
      active: true,
    } as any)

    const forbidden = await DELETE(makeRequest('DELETE', 'disc-other'), {
      params: Promise.resolve({ id: 'disc-other' }),
    })
    expect(forbidden.status).toBe(403)

    vi.mocked(prisma.discount.findUnique).mockResolvedValueOnce(null)
    const notFound = await DELETE(makeRequest('DELETE', 'disc-missing'), {
      params: Promise.resolve({ id: 'disc-missing' }),
    })
    expect(notFound.status).toBe(404)

    const unauth = await DELETE(makeRequest('DELETE', 'disc-1', null), {
      params: Promise.resolve({ id: 'disc-1' }),
    })
    expect(unauth.status).toBe(401)
  })
})
