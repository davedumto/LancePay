import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    kycApplication: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const NOW = new Date('2026-10-17T12:00:00.000Z')

function makeRequest(body?: unknown, token: string | null = 'valid-token'): NextRequest {
  return new NextRequest('http://localhost/api/kyc/submit', {
    method: 'POST',
    headers: token
      ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/kyc/submit (#1657)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)

    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as any)
    vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.kycApplication.upsert).mockImplementation(
      (async (args: any) => ({
        id: 'kyc-1',
        userId: args.create.userId,
        ...args.create,
        createdAt: NOW,
        updatedAt: NOW,
      })) as any,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates an initial basic KYC application with status="pending" and submittedAt=now', async () => {
    const res = await POST(
      makeRequest({
        level: 'basic',
        fullName: 'Ada Okafor',
        dateOfBirth: '1994-05-20',
        countryCode: 'ng',
      }),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.resubmitted).toBe(false)
    expect(body.application.status).toBe('pending')
    expect(body.application.level).toBe('basic')
    expect(body.application.fullName).toBe('Ada Okafor')
    expect(body.application.countryCode).toBe('NG')
    expect(body.application.submittedAt).toBe(NOW.toISOString())
  })

  it('upserts over a prior rejected KYC application (clearing rejectionReason and setting status="pending")', async () => {
    vi.mocked(prisma.kycApplication.findUnique).mockResolvedValueOnce({
      id: 'kyc-old',
      status: 'rejected',
    } as any)

    const res = await POST(
      makeRequest({
        level: 'enhanced',
        fullName: 'Ada Okafor',
        dateOfBirth: '1994-05-20',
        countryCode: 'NG',
        addressLine1: '12 Marina Road',
        city: 'Lagos',
        postalCode: '100001',
      }),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.resubmitted).toBe(true)
    expect(body.application.status).toBe('pending')
    expect(body.application.rejectionReason).toBeNull()

    const upsertCall = vi.mocked(prisma.kycApplication.upsert).mock.calls[0][0] as any
    expect(upsertCall.where).toEqual({ userId: 'user-1' })
    expect(upsertCall.update.status).toBe('pending')
    expect(upsertCall.update.rejectionReason).toBeNull()
    expect(upsertCall.update.submittedAt).toEqual(NOW)
  })

  it('returns 409 Conflict when the user already has a pending or approved KYC application', async () => {
    vi.mocked(prisma.kycApplication.findUnique).mockResolvedValueOnce({
      id: 'kyc-pending',
      status: 'pending',
    } as any)

    const pendingRes = await POST(
      makeRequest({
        level: 'basic',
        fullName: 'Ada Okafor',
        dateOfBirth: '1994-05-20',
        countryCode: 'NG',
      }),
    )
    expect(pendingRes.status).toBe(409)
    expect((await pendingRes.json()).code).toBe('KYC_APPLICATION_ALREADY_EXISTS')

    vi.mocked(prisma.kycApplication.findUnique).mockResolvedValueOnce({
      id: 'kyc-approved',
      status: 'approved',
    } as any)

    const approvedRes = await POST(
      makeRequest({
        level: 'basic',
        fullName: 'Ada Okafor',
        dateOfBirth: '1994-05-20',
        countryCode: 'NG',
      }),
    )
    expect(approvedRes.status).toBe(409)
    expect(prisma.kycApplication.upsert).not.toHaveBeenCalled()
  })

  it('validates required fields per KYC level (basic vs intermediate/enhanced)', async () => {
    // Missing address fields for enhanced level -> 400
    const missingAddress = await POST(
      makeRequest({
        level: 'enhanced',
        fullName: 'Ada Okafor',
        dateOfBirth: '1994-05-20',
        countryCode: 'NG',
      }),
    )
    expect(missingAddress.status).toBe(400)
    expect((await missingAddress.json()).code).toBe('MISSING_ENHANCED_KYC_FIELDS')

    // Invalid countryCode -> 400
    const badCountry = await POST(
      makeRequest({
        level: 'basic',
        fullName: 'Ada Okafor',
        dateOfBirth: '1994-05-20',
        countryCode: 'NGA',
      }),
    )
    expect(badCountry.status).toBe(400)

    // Invalid KYC level -> 400
    const badLevel = await POST(
      makeRequest({
        level: 'vip',
        fullName: 'Ada Okafor',
        dateOfBirth: '1994-05-20',
        countryCode: 'NG',
      }),
    )
    expect(badLevel.status).toBe(400)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(makeRequest({}, null))
    expect(res.status).toBe(401)
  })
})
