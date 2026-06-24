import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    lateFeePolicy: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const policyDelegate = prisma.lateFeePolicy as unknown as {
  findMany: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  updateMany: ReturnType<typeof vi.fn>
}

const BASE_URL = 'http://localhost/api/routes-b/late-fee-policies'
const CLAIMS = { userId: 'privy-1' }
const USER = { id: 'user-1' }

function makeGet(authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function makePost(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader
      ? { authorization: authHeader, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const VALID_BODY = {
  name: 'Standard Late Fee',
  gracePeriodDays: 7,
  feePercent: 1.5,
}

describe('GET /api/routes-b/late-fee-policies', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when no auth header', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet(null))
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet())
    expect(res.status).toBe(401)
  })

  it('returns an empty list when user has no policies', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    policyDelegate.findMany.mockResolvedValue([])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.policies).toEqual([])
  })

  it('returns the user policies in descending createdAt order', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    const row = {
      id: 'p-1',
      name: 'Standard Late Fee',
      description: null,
      gracePeriodDays: 7,
      feePercent: 1.5,
      isDefault: false,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    }
    policyDelegate.findMany.mockResolvedValue([row])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.policies).toHaveLength(1)
    expect(body.policies[0]).toMatchObject({ id: 'p-1', name: 'Standard Late Fee' })
    expect(policyDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    )
  })
})

describe('POST /api/routes-b/late-fee-policies', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost(VALID_BODY, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 when name is missing', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    const res = await POST(makePost({ gracePeriodDays: 7, feePercent: 1.5 }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/name/)
  })

  it('returns 400 when gracePeriodDays is not an integer', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    const res = await POST(makePost({ ...VALID_BODY, gracePeriodDays: 1.5 }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/gracePeriodDays/)
  })

  it('returns 400 when feePercent is out of range', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    const res = await POST(makePost({ ...VALID_BODY, feePercent: 150 }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/feePercent/)
  })

  it('returns 400 for invalid JSON body', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    const req = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: 'not-json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('creates a policy and returns 201', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    policyDelegate.updateMany.mockResolvedValue({ count: 0 })
    const created = {
      id: 'p-new',
      name: 'Standard Late Fee',
      description: null,
      gracePeriodDays: 7,
      feePercent: 1.5,
      isDefault: false,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    }
    policyDelegate.create.mockResolvedValue(created)
    const res = await POST(makePost(VALID_BODY))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.policy).toMatchObject({ id: 'p-new', name: 'Standard Late Fee' })
    expect(policyDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', name: 'Standard Late Fee' }),
      }),
    )
  })

  it('clears existing default before setting new default', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    policyDelegate.updateMany.mockResolvedValue({ count: 1 })
    policyDelegate.create.mockResolvedValue({
      id: 'p-default',
      name: 'Default Policy',
      description: null,
      gracePeriodDays: 0,
      feePercent: 2,
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await POST(makePost({ ...VALID_BODY, isDefault: true }))
    expect(res.status).toBe(201)
    expect(policyDelegate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', isDefault: true } }),
    )
  })
})
