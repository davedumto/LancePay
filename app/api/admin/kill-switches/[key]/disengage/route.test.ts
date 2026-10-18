import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    killSwitch: {
      findUnique: vi.fn(),
      update: vi.fn(),
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

import { POST, killSwitchSharedCache } from './route'

function makePostRequest(
  key: string,
  body: unknown,
  token: string | null = 'admin-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/admin/kill-switches/${key}/disengage`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

describe('POST /api/admin/kill-switches/[key]/disengage', () => {
  const engagedAtIso = new Date(Date.now() - 180_000).toISOString() // 3 minutes ago

  beforeEach(() => {
    vi.clearAllMocks()
    killSwitchSharedCache.clear()
    killSwitchSharedCache.set('withdrawals.stellar', {
      key: 'withdrawals.stellar',
      engaged: true,
      incidentReference: 'INC-2026-500',
      engagedByAdminId: 'admin-ops-1',
      engagedAt: engagedAtIso,
    })

    mockVerifyAuthToken.mockResolvedValue({
      userId: 'admin-privy-2',
      email: 'sre@lancepay.io',
      role: 'admin',
    })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin-2',
      email: 'sre@lancepay.io',
      role: 'admin',
    })
    mockPrisma.killSwitch.findUnique.mockResolvedValue({
      key: 'withdrawals.stellar',
      engaged: true,
      status: 'engaged',
      incidentReference: 'INC-2026-500',
      engagedByAdminId: 'admin-ops-1',
      engagedAt: new Date(engagedAtIso),
    })
  })

  it('rejects disengage with 409 INCIDENT_STILL_OPEN when the referenced incident is not resolved', async () => {
    mockPrisma.incident.findUnique.mockResolvedValueOnce({
      id: 'INC-2026-500',
      status: 'open',
      title: 'Horizon latency spike',
    })

    const res = await POST(
      makePostRequest('withdrawals.stellar', {
        incidentReference: 'INC-2026-500',
      }),
      { params: { key: 'withdrawals.stellar' } },
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('INCIDENT_STILL_OPEN')
    expect(mockPrisma.killSwitch.update).not.toHaveBeenCalled()
    expect(killSwitchSharedCache.get('withdrawals.stellar')?.engaged).toBe(true)
  })

  it('does not clear the shared cache if the database update fails', async () => {
    mockPrisma.incident.findUnique.mockResolvedValueOnce({
      id: 'INC-2026-500',
      status: 'resolved',
    })
    mockPrisma.killSwitch.update.mockRejectedValueOnce(
      new Error('DB connection lost'),
    )

    const res = await POST(
      makePostRequest('withdrawals.stellar', {
        incidentReference: 'INC-2026-500',
      }),
      { params: { key: 'withdrawals.stellar' } },
    )

    expect(res.status).toBe(500)
    // Shared cache entry MUST still be present because DB row was not updated
    expect(killSwitchSharedCache.get('withdrawals.stellar')?.engaged).toBe(true)
  })

  it('updates DB row before clearing shared cache and records disengaging admin plus elapsed time for postmortem', async () => {
    mockPrisma.incident.findUnique.mockResolvedValueOnce({
      id: 'INC-2026-500',
      status: 'resolved',
    })

    let cacheStateDuringDbUpdate: boolean | undefined
    mockPrisma.killSwitch.update.mockImplementationOnce(async ({ data }) => {
      // At the moment DB update executes, shared cache entry must NOT have been cleared yet
      cacheStateDuringDbUpdate =
        killSwitchSharedCache.get('withdrawals.stellar')?.engaged
      return {
        key: 'withdrawals.stellar',
        ...data,
      }
    })
    mockPrisma.killSwitchAudit.create.mockResolvedValueOnce({
      id: 'ksa-99',
    })

    const res = await POST(
      makePostRequest('withdrawals.stellar', {
        incidentReference: 'INC-2026-500',
        resolutionNotes: 'Horizon nodes healthy for 30m',
      }),
      { params: { key: 'withdrawals.stellar' } },
    )

    expect(res.status).toBe(200)
    const body = await res.json()

    // Verify cache was still populated during DB update and cleared afterwards
    expect(cacheStateDuringDbUpdate).toBe(true)
    expect(killSwitchSharedCache.get('withdrawals.stellar')).toBeUndefined()
    expect(body.cacheCleared).toBe(true)

    // Verify disengaging admin and elapsed time recorded for postmortem
    expect(body.postmortem.disengagedByAdminId).toBe('admin-2')
    expect(body.postmortem.disengagedByEmail).toBe('sre@lancepay.io')
    expect(body.postmortem.incidentReference).toBe('INC-2026-500')
    expect(body.postmortem.elapsedDurationMs).toBeGreaterThanOrEqual(175_000)
    expect(body.postmortem.elapsedDurationSeconds).toBeGreaterThanOrEqual(175)

    expect(mockPrisma.killSwitchAudit.create).toHaveBeenCalledOnce()
    const auditData = mockPrisma.killSwitchAudit.create.mock.calls[0][0].data
    expect(auditData.disengagedByAdminId).toBe('admin-2')
    expect(auditData.elapsedDurationMs).toBeGreaterThanOrEqual(175_000)
  })
})
