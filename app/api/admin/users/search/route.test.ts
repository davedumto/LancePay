import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
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
  GET,
  ADMIN_SEARCH_RATE_LIMIT_MAX,
  resetAdminSearchRateLimiter,
} from './route'

function makeGetRequest(
  queryParams: string,
  token: string | null = 'admin-token',
  extraHeaders: Record<string, string> = {},
): NextRequest {
  const headers: Record<string, string> = { ...extraHeaders }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/admin/users/search?${queryParams}`,
    {
      method: 'GET',
      headers,
    },
  )
}

describe('GET /api/admin/users/search', () => {
  const sampleMatchedUsers = [
    {
      id: 'user-1',
      privyId: 'did:privy:ext_ref_990',
      email: 'ada.lovelace@analytical.org',
      name: 'Ada Lovelace',
      phone: '+2348012345678',
      role: 'freelancer',
      wallet: {
        address: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
      virtualAccount: {
        providerRef: 'ext_ref_990',
        accountNumber: '1234567890',
      },
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    resetAdminSearchRateLimiter()

    mockVerifyAuthToken.mockResolvedValue({
      userId: 'admin-seat-1',
      email: 'support@lancepay.io',
      role: 'support_admin',
    })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin-seat-1',
      email: 'support@lancepay.io',
      role: 'support_admin',
    })
    mockPrisma.user.findMany.mockResolvedValue(sampleMatchedUsers)
  })

  it('matches across email, displayName, walletAddress, and externalReference while redacting PII by default', async () => {
    const res = await GET(makeGetRequest('q=ext_ref_990'))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.piiRedacted).toBe(true)
    expect(body.results).toHaveLength(1)
    const hit = body.results[0]
    expect(hit.email).toBe('a***@analytical.org')
    expect(hit.displayName).toBe('A*** L***')
    expect(hit.phone).toBe('***-***-5678')
    expect(hit.walletAddress).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    )
    expect(hit.externalReference).toBe('ext_ref_990')
    expect(hit.matchedFields).toContain('externalReference')
  })

  it('unmasks PII only when caller holds compliance unmask role and supplies X-Unmask-Reason header', async () => {
    // 1. Standard support_admin requesting unmask=true is rejected with 403
    const forbiddenRes = await GET(
      makeGetRequest('q=ada&unmask=true', 'admin-token', {
        'x-unmask-reason': 'Investigating AML alert',
      }),
    )
    expect(forbiddenRes.status).toBe(403)
    expect((await forbiddenRes.json()).code).toBe(
      'COMPLIANCE_UNMASK_ROLE_REQUIRED',
    )

    // 2. Compliance admin without X-Unmask-Reason header is rejected with 400
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'comp-seat-1',
      email: 'compliance@lancepay.io',
      role: 'compliance_unmask',
    })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'comp-seat-1',
      email: 'compliance@lancepay.io',
      role: 'compliance_unmask',
    })

    const missingReasonRes = await GET(makeGetRequest('q=ada&unmask=true'))
    expect(missingReasonRes.status).toBe(400)
    expect((await missingReasonRes.json()).code).toBe(
      'UNMASK_REASON_HEADER_REQUIRED',
    )

    // 3. Compliance admin with X-Unmask-Reason receives unmasked PII and logs audit trail
    const unmaskedRes = await GET(
      makeGetRequest('q=ada&unmask=true', 'admin-token', {
        'x-unmask-reason': 'AML Case #2026-441 verification',
      }),
    )
    expect(unmaskedRes.status).toBe(200)
    const unmaskedBody = await unmaskedRes.json()
    expect(unmaskedBody.piiRedacted).toBe(false)
    expect(unmaskedBody.results[0].email).toBe('ada.lovelace@analytical.org')
    expect(unmaskedBody.results[0].displayName).toBe('Ada Lovelace')
    expect(unmaskedBody.results[0].phone).toBe('+2348012345678')
    expect(mockPrisma.auditLog.create).toHaveBeenCalledOnce()
  })

  it('rate limits per admin seat so bulk harvesting of the user directory is throttled with 429', async () => {
    for (let i = 0; i < ADMIN_SEARCH_RATE_LIMIT_MAX; i++) {
      const okRes = await GET(makeGetRequest('q=ada'))
      expect(okRes.status).toBe(200)
    }

    const throttledRes = await GET(makeGetRequest('q=ada'))
    expect(throttledRes.status).toBe(429)
    expect(throttledRes.headers.get('Retry-After')).toBeTruthy()
    expect((await throttledRes.json()).code).toBe('ADMIN_SEARCH_RATE_LIMITED')

    // A different admin seat still has its own independent rate limit budget
    mockVerifyAuthToken.mockResolvedValueOnce({
      userId: 'admin-seat-2',
      role: 'support_admin',
    })
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'admin-seat-2',
      role: 'support_admin',
    })
    const otherSeatRes = await GET(makeGetRequest('q=ada'))
    expect(otherSeatRes.status).toBe(200)
  })
})
