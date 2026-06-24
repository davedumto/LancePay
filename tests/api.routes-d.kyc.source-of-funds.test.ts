import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const kycSourceOfFundsUpsert = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    kycSourceOfFunds: { upsert: kycSourceOfFundsUpsert },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/kyc/source-of-funds'

function makeRequest(body?: unknown, opts?: { auth?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = opts?.auth ?? 'Bearer token'
  if (auth) headers.authorization = auth
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const validBody = {
  sourceType: 'salary',
  annualIncome: 120000,
  currency: 'USD',
  occupation: 'Software Engineer',
  companyName: 'Tech Corp',
  supportingDocUrl: 'https://example.com/paystub.pdf',
}

describe('POST /api/routes-d/kyc/source-of-funds', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth is supplied', async () => {
    const { POST } = await import('@/app/api/routes-d/kyc/source-of-funds/route')
    const res = await POST(makeRequest(validBody, { auth: '' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid sourceType', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/kyc/source-of-funds/route')
    const res = await POST(makeRequest({ ...validBody, sourceType: 'lottery_winnings' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid annualIncome (negative)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/kyc/source-of-funds/route')
    const res = await POST(makeRequest({ ...validBody, annualIncome: -500 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid currency (not 3-letters)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/kyc/source-of-funds/route')
    const res = await POST(makeRequest({ ...validBody, currency: 'US' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid occupation (too short)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/kyc/source-of-funds/route')
    const res = await POST(makeRequest({ ...validBody, occupation: 'a' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid supportingDocUrl (not https)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/kyc/source-of-funds/route')
    const res = await POST(makeRequest({ ...validBody, supportingDocUrl: 'http://example.com/doc.pdf' }))
    expect(res.status).toBe(400)
  })

  it('returns 201 and upserts on a valid submission', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycSourceOfFundsUpsert.mockResolvedValue({ id: 'sof_1', sourceType: 'salary' })
    const { POST } = await import('@/app/api/routes-d/kyc/source-of-funds/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(201)
    expect(kycSourceOfFundsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1' },
        create: expect.objectContaining({
          userId: 'user_1',
          sourceType: 'salary',
          occupation: 'Software Engineer',
        }),
      }),
    )
  })
})
