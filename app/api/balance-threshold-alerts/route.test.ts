import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockAlertFindMany = vi.fn()
const mockAlertCreate = vi.fn()

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
      create: (...args: unknown[]) => mockAlertCreate(...args),
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

import { GET, POST } from './route'

function makeRequest(
  url: string,
  options?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Balance Threshold Alerts API (/api/balance-threshold-alerts)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
  })

  it('validates that direction is either below or above and threshold is non-negative', async () => {
    const reqBadDirection = makeRequest(
      'http://localhost/api/balance-threshold-alerts',
      {
        token: 'valid-token',
        body: { direction: 'sideways', threshold: 100 },
      },
    )
    const resBadDirection = await POST(reqBadDirection)
    expect(resBadDirection.status).toBe(400)
    const jsonBadDir = await resBadDirection.json()
    expect(jsonBadDir.code).toBe('INVALID_DIRECTION')

    const reqNegativeThreshold = makeRequest(
      'http://localhost/api/balance-threshold-alerts',
      {
        token: 'valid-token',
        body: { direction: 'below', threshold: -10 },
      },
    )
    const resNegativeThreshold = await POST(reqNegativeThreshold)
    expect(resNegativeThreshold.status).toBe(400)
    const jsonNeg = await resNegativeThreshold.json()
    expect(jsonNeg.code).toBe('INVALID_THRESHOLD')

    expect(mockAlertCreate).not.toHaveBeenCalled()
  })

  it('defaults enabled to true and allows multiple alerts per user for different currencies or thresholds', async () => {
    let seq = 0
    mockAlertCreate.mockImplementation(async ({ data }: any) => {
      seq += 1
      return {
        id: `alert-${seq}`,
        ...data,
        lastTriggeredAt: null,
        createdAt: new Date('2026-04-01T10:00:00Z'),
        updatedAt: new Date('2026-04-01T10:00:00Z'),
      }
    })

    // First alert: USD below 100 (enabled omitted -> defaults to true)
    const res1 = await POST(
      makeRequest('http://localhost/api/balance-threshold-alerts', {
        token: 'valid-token',
        body: { direction: 'below', threshold: 100 },
      }),
    )
    expect(res1.status).toBe(201)
    const json1 = await res1.json()
    expect(json1.alert.currency).toBe('USD')
    expect(json1.alert.direction).toBe('below')
    expect(json1.alert.threshold).toBe(100)
    expect(json1.alert.enabled).toBe(true)

    // Second alert for same user: USD above 5000 (different threshold)
    const res2 = await POST(
      makeRequest('http://localhost/api/balance-threshold-alerts', {
        token: 'valid-token',
        body: { direction: 'above', threshold: 5000, currency: 'USD' },
      }),
    )
    expect(res2.status).toBe(201)
    const json2 = await res2.json()
    expect(json2.alert.id).toBe('alert-2')
    expect(json2.alert.direction).toBe('above')
    expect(json2.alert.threshold).toBe(5000)
    expect(json2.alert.enabled).toBe(true)

    // Third alert for same user: EUR below 0 (non-negative zero threshold, different currency)
    const res3 = await POST(
      makeRequest('http://localhost/api/balance-threshold-alerts', {
        token: 'valid-token',
        body: { direction: 'below', threshold: 0, currency: 'eur' },
      }),
    )
    expect(res3.status).toBe(201)
    const json3 = await res3.json()
    expect(json3.alert.id).toBe('alert-3')
    expect(json3.alert.currency).toBe('EUR')
    expect(json3.alert.threshold).toBe(0)
    expect(json3.alert.enabled).toBe(true)

    expect(mockAlertCreate).toHaveBeenCalledTimes(3)
  })

  it('lists balance threshold alerts for the authenticated user via GET', async () => {
    mockAlertFindMany.mockResolvedValue([
      {
        id: 'alert-1',
        userId: 'user-1',
        currency: 'USD',
        direction: 'below',
        threshold: 100,
        enabled: true,
        lastTriggeredAt: null,
        createdAt: new Date('2026-04-01T10:00:00Z'),
        updatedAt: new Date('2026-04-01T10:00:00Z'),
      },
    ])

    const req = makeRequest('http://localhost/api/balance-threshold-alerts', {
      method: 'GET',
      token: 'valid-token',
    })

    const res = await GET(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.total).toBe(1)
    expect(json.alerts[0].id).toBe('alert-1')
  })
})
