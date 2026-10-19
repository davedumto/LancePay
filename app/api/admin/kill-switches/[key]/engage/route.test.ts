import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { sharedCache } from '@/lib/shared-cache'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    incident: {
      findUnique: vi.fn(),
    },
    killSwitch: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('POST /api/admin/kill-switches/[key]/engage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sharedCache.clear()
  })

  function makeRequest(key: string, body: unknown, token = 'admin-token') {
    return {
      req: new NextRequest(`http://localhost:3000/api/admin/kill-switches/${key}/engage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      params: Promise.resolve({ key }),
    }
  }

  function setupAdmin(isAdmin = true) {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_admin' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin_123',
      email: 'admin@lancepay.com',
      role: isAdmin ? 'admin' : 'user',
    } as any)
  }

  it('engages a kill switch, records snapshots, and propagates state to shared cache', async () => {
    setupAdmin(true)

    vi.mocked(prisma.incident.findUnique).mockResolvedValue({
      id: 'inc_1',
      reference: 'INC-991',
      status: 'open',
    } as any)

    vi.mocked(prisma.killSwitch.findUnique).mockResolvedValue({
      id: 'ks_1',
      key: 'withdrawals',
      subsystem: 'withdrawals',
      status: 'disengaged',
      incidentRef: null,
      engagedAt: null,
      disengagedAt: null,
    } as any)

    const now = new Date()
    vi.mocked(prisma.killSwitch.upsert).mockResolvedValue({
      id: 'ks_1',
      key: 'withdrawals',
      subsystem: 'withdrawals',
      status: 'engaged',
      incidentRef: 'INC-991',
      reason: 'RPC provider degraded',
      beforeSnapshot: { status: 'disengaged' },
      afterSnapshot: { status: 'engaged', incidentRef: 'INC-991' },
      engagedAt: now,
      engagedById: 'admin_123',
      updatedAt: now,
    } as any)

    const { req, params } = makeRequest('withdrawals', {
      incidentRef: 'INC-991',
      reason: 'RPC provider degraded',
    })

    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.killSwitch.status).toBe('engaged')
    expect(json.cacheUpdated).toBe(true)

    // Verify before/after snapshots passed to upsert
    expect(prisma.killSwitch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'withdrawals' },
        update: expect.objectContaining({
          status: 'engaged',
          incidentRef: 'INC-991',
          beforeSnapshot: expect.objectContaining({ status: 'disengaged' }),
          afterSnapshot: expect.objectContaining({
            status: 'engaged',
            incidentRef: 'INC-991',
            engagedById: 'admin_123',
          }),
        }),
      }),
    )

    // Verify shared cache propagated
    const cached = sharedCache.get('killswitch:withdrawals')
    expect(cached).not.toBeNull()
    expect((cached as any).status).toBe('engaged')
    expect((cached as any).incidentRef).toBe('INC-991')
  })

  it('rejects missing incident reference with 400', async () => {
    setupAdmin(true)

    const { req, params } = makeRequest('withdrawals', { reason: 'No incident' })
    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('INCIDENT_REF_REQUIRED')
    expect(prisma.killSwitch.upsert).not.toHaveBeenCalled()
  })

  it('rejects engaging when referenced incident is already resolved', async () => {
    setupAdmin(true)

    vi.mocked(prisma.incident.findUnique).mockResolvedValue({
      id: 'inc_old',
      reference: 'INC-100',
      status: 'resolved',
    } as any)

    const { req, params } = makeRequest('withdrawals', { incidentRef: 'INC-100' })
    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('INCIDENT_ALREADY_RESOLVED')
    expect(prisma.killSwitch.upsert).not.toHaveBeenCalled()
  })

  it('rejects engaging an already engaged switch with 409', async () => {
    setupAdmin(true)

    vi.mocked(prisma.incident.findUnique).mockResolvedValue({
      id: 'inc_active',
      reference: 'INC-991',
      status: 'open',
    } as any)

    vi.mocked(prisma.killSwitch.findUnique).mockResolvedValue({
      id: 'ks_1',
      key: 'withdrawals',
      status: 'engaged',
      incidentRef: 'INC-990',
    } as any)

    const { req, params } = makeRequest('withdrawals', { incidentRef: 'INC-991' })
    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe('SWITCH_ALREADY_ENGAGED')
    expect(prisma.killSwitch.upsert).not.toHaveBeenCalled()
  })

  it('rejects non-admin caller with 403 Forbidden', async () => {
    setupAdmin(false)

    const { req, params } = makeRequest('withdrawals', { incidentRef: 'INC-1' })
    const res = await POST(req, { params })
    expect(res.status).toBe(403)
  })

  it('rejects unauthenticated request with 403 Forbidden', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const { req, params } = makeRequest('withdrawals', { incidentRef: 'INC-1' }, '')
    const res = await POST(req, { params })
    expect(res.status).toBe(403)
  })

  it('returns 500 when database throws an error', async () => {
    setupAdmin(true)
    vi.mocked(prisma.incident.findUnique).mockRejectedValue(new Error('DB failure'))

    const { req, params } = makeRequest('withdrawals', { incidentRef: 'INC-1' })
    const res = await POST(req, { params })
    expect(res.status).toBe(500)
  })
})
