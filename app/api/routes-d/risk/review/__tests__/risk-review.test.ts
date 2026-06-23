import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    riskAssessment: { create: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const riskDelegate = prisma.riskAssessment as unknown as { create: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-d/risk/review'

function makePost(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-d/risk/review', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost({ entityType: 'user', entityId: 'u-1' }, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 when entityType is missing', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await POST(makePost({ entityId: 'u-1' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when entityType is invalid', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await POST(makePost({ entityType: 'payment', entityId: 'u-1' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when entityId is missing', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await POST(makePost({ entityType: 'user' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when reason exceeds 1000 characters', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await POST(makePost({ entityType: 'user', entityId: 'u-1', reason: 'x'.repeat(1001) }))
    expect(res.status).toBe(400)
  })

  it('creates a risk assessment and returns 201', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    riskDelegate.create.mockResolvedValue({
      id: 'ra-1',
      entityType: 'invoice',
      entityId: 'inv-1',
      status: 'pending_review',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })
    const res = await POST(makePost({ entityType: 'invoice', entityId: 'inv-1', reason: 'suspicious amount' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.assessment).toMatchObject({ id: 'ra-1', status: 'pending_review' })
    expect(riskDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: 'invoice',
          entityId: 'inv-1',
          status: 'pending_review',
        }),
      }),
    )
  })

  it('accepts an optional reason', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    riskDelegate.create.mockResolvedValue({
      id: 'ra-2',
      entityType: 'user',
      entityId: 'u-1',
      status: 'pending_review',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })
    const res = await POST(makePost({ entityType: 'user', entityId: 'u-1' }))
    expect(res.status).toBe(201)
  })
})
