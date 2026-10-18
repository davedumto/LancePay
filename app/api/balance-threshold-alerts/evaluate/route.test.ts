import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockAlertFindMany = vi.fn()
const mockAlertUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    balanceThresholdAlert: {
      findMany: (...args: unknown[]) => mockAlertFindMany(...args),
      update: (...args: unknown[]) => mockAlertUpdate(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { POST, resetAlertLatchState } from './route'

function makeRequest(url: string, options?: { token?: string; body?: unknown }) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('POST /api/balance-threshold-alerts/evaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAlertLatchState()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
  })

  it('only evaluates rows where enabled is true and updates lastTriggeredAt only for alerts that actually fire', async () => {
    mockAlertFindMany.mockResolvedValue([
      {
        id: 'alert-enabled-firing',
        userId: 'user-1',
        currency: 'USD',
        direction: 'below',
        threshold: 100,
        enabled: true,
        lastTriggeredAt: null,
      },
      {
        id: 'alert-enabled-not-firing',
        userId: 'user-1',
        currency: 'USD',
        direction: 'above',
        threshold: 500,
        enabled: true,
        lastTriggeredAt: null,
      },
      {
        id: 'alert-disabled',
        userId: 'user-1',
        currency: 'USD',
        direction: 'below',
        threshold: 200,
        enabled: false,
        lastTriggeredAt: null,
      },
    ])

    mockAlertUpdate.mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      lastTriggeredAt: data.lastTriggeredAt,
    }))

    const req = makeRequest(
      'http://localhost/api/balance-threshold-alerts/evaluate',
      {
        token: 'valid-token',
        body: { balances: { USD: 60 } },
      },
    )

    const res = await POST(req)
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.evaluatedCount).toBe(2)
    expect(json.triggeredCount).toBe(1)
    expect(json.triggeredAlerts).toHaveLength(1)
    expect(json.triggeredAlerts[0].id).toBe('alert-enabled-firing')

    // Verify Prisma query filtered by enabled: true
    expect(mockAlertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', enabled: true },
      }),
    )

    // Verify lastTriggeredAt was updated ONLY for the alert that fired
    expect(mockAlertUpdate).toHaveBeenCalledTimes(1)
    expect(mockAlertUpdate).toHaveBeenCalledWith({
      where: { id: 'alert-enabled-firing' },
      data: { lastTriggeredAt: expect.any(Date) },
    })
  })

  it('avoids re-firing an alert once a threshold is crossed and stays crossed, only firing again after the balance moves back across the threshold in the other direction', async () => {
    const alertState = {
      id: 'alert-below-100',
      userId: 'user-1',
      currency: 'USD',
      direction: 'below',
      threshold: 100,
      enabled: true,
      lastTriggeredAt: null as Date | null,
    }

    mockAlertFindMany.mockImplementation(async () => [{ ...alertState }])
    mockAlertUpdate.mockImplementation(async ({ data }: any) => {
      alertState.lastTriggeredAt = data.lastTriggeredAt
      return { ...alertState }
    })

    // 1. Balance drops to $80 (< $100) -> fires!
    const res1 = await POST(
      makeRequest('http://localhost/api/balance-threshold-alerts/evaluate', {
        token: 'valid-token',
        body: { balances: { USD: 80 } },
      }),
    )
    const json1 = await res1.json()
    expect(json1.triggeredCount).toBe(1)
    expect(mockAlertUpdate).toHaveBeenCalledTimes(1)
    const firstTriggerAt = alertState.lastTriggeredAt
    expect(firstTriggerAt).toBeInstanceOf(Date)

    // 2. Balance drops further to $40 (still < $100) -> must NOT re-fire or update lastTriggeredAt!
    const res2 = await POST(
      makeRequest('http://localhost/api/balance-threshold-alerts/evaluate', {
        token: 'valid-token',
        body: { balances: { USD: 40 } },
      }),
    )
    const json2 = await res2.json()
    expect(json2.triggeredCount).toBe(0)
    expect(json2.evaluations[0].suppressedDuplicate).toBe(true)
    expect(mockAlertUpdate).toHaveBeenCalledTimes(1)
    expect(alertState.lastTriggeredAt).toBe(firstTriggerAt)

    // 3. Balance recovers to $130 (>= $100, moved back across threshold) -> re-arms without firing or updating lastTriggeredAt
    const res3 = await POST(
      makeRequest('http://localhost/api/balance-threshold-alerts/evaluate', {
        token: 'valid-token',
        body: { balances: { USD: 130 } },
      }),
    )
    const json3 = await res3.json()
    expect(json3.triggeredCount).toBe(0)
    expect(mockAlertUpdate).toHaveBeenCalledTimes(1)

    // 4. Balance drops again to $75 (< $100) -> fires again and updates lastTriggeredAt!
    const res4 = await POST(
      makeRequest('http://localhost/api/balance-threshold-alerts/evaluate', {
        token: 'valid-token',
        body: { balances: { USD: 75 } },
      }),
    )
    const json4 = await res4.json()
    expect(json4.triggeredCount).toBe(1)
    expect(json4.triggeredAlerts[0].id).toBe('alert-below-100')
    expect(mockAlertUpdate).toHaveBeenCalledTimes(2)
  })
})
