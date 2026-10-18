import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    killSwitch: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    incident: {
      findUnique: vi.fn(),
    },
    killSwitchAudit: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import {
  POST,
  killSwitchSharedCache,
  isKillSwitchEngagedCached,
} from './route'

function makePostRequest(
  key: string,
  body: unknown,
  token: string | null = 'admin-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/admin/kill-switches/${key}/engage`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

describe('POST /api/admin/kill-switches/[key]/engage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    killSwitchSharedCache.clear()

    mockVerifyAuthToken.mockResolvedValue({
      userId: 'admin-privy-1',
      email: 'oncall@lancepay.io',
      role: 'admin',
    })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'oncall@lancepay.io',
      role: 'admin',
    })
    mockPrisma.incident.findUnique.mockResolvedValue({
      id: 'INC-2026-900',
      status: 'open',
    })
    mockPrisma.killSwitch.findUnique.mockResolvedValue({
      key: 'payouts.batch',
      engaged: false,
      status: 'disengaged',
      incidentReference: null,
      reason: null,
      engagedByAdminId: null,
      engagedByEmail: null,
      engagedAt: null,
    })
  })

  it('requires an incidentReference and rejects missing or already-resolved incidents', async () => {
    const missingInc = await POST(
      makePostRequest('payouts.batch', { reason: 'Urgent halt' }),
      { params: { key: 'payouts.batch' } },
    )
    expect(missingInc.status).toBe(400)
    expect((await missingInc.json()).code).toBe('INCIDENT_REFERENCE_REQUIRED')

    mockPrisma.incident.findUnique.mockResolvedValueOnce({
      id: 'INC-OLD',
      status: 'resolved',
    })
    const closedInc = await POST(
      makePostRequest('payouts.batch', {
        incidentReference: 'INC-OLD',
        reason: 'Trying to reuse resolved incident',
      }),
      { params: { key: 'payouts.batch' } },
    )
    expect(closedInc.status).toBe(409)
    expect((await closedInc.json()).code).toBe('INCIDENT_NOT_OPEN')
  })

  it('propagates engage state to shared cache and records before and after snapshots for later disengage verification', async () => {
    mockPrisma.killSwitch.upsert.mockImplementationOnce(async ({ update }) => ({
      key: 'payouts.batch',
      ...update,
    }))
    mockPrisma.killSwitchAudit.create.mockResolvedValueOnce({
      id: 'ksa-engage-1',
    })

    expect(isKillSwitchEngagedCached('payouts.batch')).toBe(false)

    const res = await POST(
      makePostRequest('payouts.batch', {
        incidentReference: 'INC-2026-900',
        reason: 'Elevated downstream anchor error rate',
      }),
      { params: { key: 'payouts.batch' } },
    )

    expect(res.status).toBe(201)
    const body = await res.json()

    // 1. Shared cache immediately reflects engaged state without DB roundtrip
    expect(body.cachePropagated).toBe(true)
    expect(isKillSwitchEngagedCached('payouts.batch')).toBe(true)
    expect(killSwitchSharedCache.get('payouts.batch')?.incidentReference).toBe(
      'INC-2026-900',
    )

    // 2. Before and after snapshots are recorded on response, DB, and audit trail
    expect(body.snapshots.before).toEqual({
      key: 'payouts.batch',
      engaged: false,
      status: 'disengaged',
      incidentReference: null,
      reason: null,
      engagedByAdminId: null,
      engagedByEmail: null,
      engagedAt: null,
    })
    expect(body.snapshots.after).toMatchObject({
      key: 'payouts.batch',
      engaged: true,
      status: 'engaged',
      incidentReference: 'INC-2026-900',
      reason: 'Elevated downstream anchor error rate',
      engagedByAdminId: 'admin-1',
      engagedByEmail: 'oncall@lancepay.io',
    })

    expect(mockPrisma.killSwitchAudit.create).toHaveBeenCalledOnce()
    const auditArg = mockPrisma.killSwitchAudit.create.mock.calls[0][0].data
    expect(auditArg.beforeSnapshot.engaged).toBe(false)
    expect(auditArg.afterSnapshot.engaged).toBe(true)
    expect(auditArg.incidentReference).toBe('INC-2026-900')
  })

  it('rejects re-engaging an already engaged kill switch with 409', async () => {
    mockPrisma.killSwitch.findUnique.mockResolvedValueOnce({
      key: 'payouts.batch',
      engaged: true,
      status: 'engaged',
      incidentReference: 'INC-2026-900',
    })

    const res = await POST(
      makePostRequest('payouts.batch', {
        incidentReference: 'INC-2026-900',
      }),
      { params: { key: 'payouts.batch' } },
    )
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('KILL_SWITCH_ALREADY_ENGAGED')
  })
})
