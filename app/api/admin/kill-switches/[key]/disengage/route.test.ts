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
      update: vi.fn(),
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

describe('POST /api/admin/kill-switches/[key]/disengage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sharedCache.clear()
  })

  function makeRequest(key: string, body: unknown, token = 'admin-token') {
    return {
      req: new NextRequest(`http://localhost:3000/api/admin/kill-switches/${key}/disengage`, {
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

  it('disengages a kill switch after incident is resolved and clears cache after DB update', async () => {
    setupAdmin(true)

    // Pre-populate cache to test cache clearing
    sharedCache.set('killswitch:withdrawals', { status: 'engaged' })

    vi.mocked(prisma.incident.findUnique).mockResolvedValue({
      id: 'inc_1',
      reference: 'INC-991',
      status: 'resolved',
    } as any)

    const engagedAt = new Date(Date.now() - 3600 * 1000) // 1 hour ago
    vi.mocked(prisma.killSwitch.findUnique).mockResolvedValue({
      id: 'ks_1',
      key: 'withdrawals',
      status: 'engaged',
      incidentRef: 'INC-991',
      engagedAt,
    } as any)

    const now = new Date()
    vi.mocked(prisma.killSwitch.update).mockResolvedValue({
      id: 'ks_1',
      key: 'withdrawals',
      subsystem: 'withdrawals',
      status: 'disengaged',
      incidentRef: 'INC-991',
      engagedAt,
      engagedById: 'admin_123',
      disengagedAt: now,
      disengagedById: 'admin_123',
      elapsedSeconds: 3600,
      reason: 'Issue resolved',
      updatedAt: now,
    } as any)

    const { req, params } = makeRequest('withdrawals', {
      incidentRef: 'INC-991',
      resolutionSummary: 'Issue resolved',
    })

    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.killSwitch.status).toBe('disengaged')
    expect(json.elapsedSeconds).toBe(3600)
    expect(json.cacheCleared).toBe(true)

    // Verify cache was cleared
    expect(sharedCache.get('killswitch:withdrawals')).toBeNull()
  })

  it('rejects disengaging when referenced incident is still open', async () => {
    setupAdmin(true)

    vi.mocked(prisma.incident.findUnique).mockResolvedValue({
      id: 'inc_open',
      reference: 'INC-991',
      status: 'open',
    } as any)

    const { req, params } = makeRequest('withdrawals', { incidentRef: 'INC-991' })
    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('INCIDENT_NOT_RESOLVED')
    expect(prisma.killSwitch.update).not.toHaveBeenCalled()
  })

  it('returns 404 when referenced incident is not found', async () => {
    setupAdmin(true)

    vi.mocked(prisma.incident.findUnique).mockResolvedValue(null)

    const { req, params } = makeRequest('withdrawals', { incidentRef: 'INC-UNKNOWN' })
    const res = await POST(req, { params })
    expect(res.status).toBe(404)
    expect(prisma.killSwitch.update).not.toHaveBeenCalled()
  })

  it('rejects disengaging a switch that is not currently engaged', async () => {
    setupAdmin(true)

    vi.mocked(prisma.incident.findUnique).mockResolvedValue({
      id: 'inc_res',
      reference: 'INC-991',
      status: 'resolved',
    } as any)

    vi.mocked(prisma.killSwitch.findUnique).mockResolvedValue({
      id: 'ks_1',
      key: 'withdrawals',
      status: 'disengaged',
    } as any)

    const { req, params } = makeRequest('withdrawals', { incidentRef: 'INC-991' })
    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe('SWITCH_NOT_ENGAGED')
  })

  it('rejects non-admin caller with 403 Forbidden', async () => {
    setupAdmin(false)

    const { req, params } = makeRequest('withdrawals', { incidentRef: 'INC-991' })
    const res = await POST(req, { params })
    expect(res.status).toBe(403)
  })

  it('returns 500 when database throws', async () => {
    setupAdmin(true)
    vi.mocked(prisma.incident.findUnique).mockRejectedValue(new Error('DB failure'))

    const { req, params } = makeRequest('withdrawals', { incidentRef: 'INC-991' })
    const res = await POST(req, { params })
    expect(res.status).toBe(500)
  })
})
