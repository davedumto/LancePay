import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const sourceOfFundsUpsert = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    sourceOfFundsDeclaration: { upsert: sourceOfFundsUpsert },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function makeRequest(body?: unknown, token: string | null = 'valid-token') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/routes-d/kyc/source-of-funds', {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/routes-d/kyc/source-of-funds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/kyc/source-of-funds/route')
    const res = await POST(makeRequest({ sourceType: 'salary', details: 'Income from employment' }, null))
    expect(res.status).toBe(401)
  })

  it('rejects invalid payloads', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    const { POST } = await import('@/app/api/routes-d/kyc/source-of-funds/route')
    const res = await POST(makeRequest({ sourceType: 'unknown', details: 'short' }))
    expect(res.status).toBe(400)
    expect(sourceOfFundsUpsert).not.toHaveBeenCalled()
  })

  it('stores a source-of-funds declaration for the authenticated user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    sourceOfFundsUpsert.mockResolvedValue({
      id: 'sof_1',
      sourceType: 'business_income',
      details: 'Revenue from freelance consulting and product work',
      monthlyVolumeUsdc: '5000.00',
      annualIncomeUsdc: '60000.00',
      createdAt: new Date('2026-06-24T00:00:00Z'),
      updatedAt: new Date('2026-06-24T00:00:00Z'),
    })

    const { POST } = await import('@/app/api/routes-d/kyc/source-of-funds/route')
    const res = await POST(
      makeRequest({
        sourceType: 'business_income',
        details: 'Revenue from freelance consulting and product work',
        monthlyVolumeUsdc: 5000,
        annualIncomeUsdc: 60000,
      }),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.declaration).toMatchObject({ id: 'sof_1', sourceType: 'business_income' })
    expect(sourceOfFundsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1' },
        create: expect.objectContaining({ userId: 'user_1', sourceType: 'business_income' }),
      }),
    )
  })
})
