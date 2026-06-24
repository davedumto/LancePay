import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    kycApplication: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const kycDelegate = prisma.kycApplication as unknown as { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-d/verify/identity'

function makePost(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const mockVerification = {
  id: 'kyc-uuid-1',
  status: 'pending',
  level: 'national_id',
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
}

describe('POST /api/routes-d/verify/identity', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when no auth header', async () => {
    const res = await POST(makePost({}, null))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 when token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost({}))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid token')
  })

  it('returns 404 when user not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue(null)
    const res = await POST(makePost({}))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('User not found')
  })

  it('returns 409 when KYC already pending', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    kycDelegate.findUnique.mockResolvedValue({ id: 'kyc-1', status: 'pending', level: 'national_id' })
    const res = await POST(makePost({}))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('Identity verification already pending')
  })

  it('returns 409 when identity already verified (approved)', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    kycDelegate.findUnique.mockResolvedValue({ id: 'kyc-1', status: 'approved', level: 'passport' })
    const res = await POST(makePost({}))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('Identity already verified')
  })

  it('returns 400 when idType is invalid', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await POST(makePost({ idType: 'selfie' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid idType')
  })

  it('returns 201 with verification object on success', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    kycDelegate.findUnique.mockResolvedValue(null)
    kycDelegate.upsert.mockResolvedValue(mockVerification)
    const res = await POST(makePost({ idType: 'passport' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.verification).toMatchObject({
      id: 'kyc-uuid-1',
      status: 'pending',
      level: 'national_id',
    })
  })

  it('returns 201 with default idType when not provided', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    kycDelegate.findUnique.mockResolvedValue(null)
    kycDelegate.upsert.mockResolvedValue(mockVerification)
    const res = await POST(makePost({}))
    expect(res.status).toBe(201)
    const upsertCall = kycDelegate.upsert.mock.calls[0][0] as Record<string, unknown>
    const createData = upsertCall.create as Record<string, unknown>
    expect(createData.level).toBe('national_id')
  })
})
