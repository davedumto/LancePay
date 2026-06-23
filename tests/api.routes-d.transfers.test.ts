import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const txFindMany = vi.fn()
const txCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    transaction: { findMany: txFindMany, create: txCreate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/transfers'

function getReq() {
  return new NextRequest(URL, { headers: { authorization: 'Bearer tok' } })
}
function postReq(body: unknown) {
  return new NextRequest(URL, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
  })
}

describe('GET /api/routes-d/transfers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/transfers/route')
    const res = await GET(new NextRequest(URL))
    expect(res.status).toBe(401)
  })

  it('returns paginated transfers list', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    txFindMany.mockResolvedValue([
      { id: 't1', type: 'transfer', status: 'pending', amount: { toString: () => '50.00' }, currency: 'USD', externalId: 'ext1', createdAt: new Date(), completedAt: null },
    ])
    const { GET } = await import('@/app/api/routes-d/transfers/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.transfers).toHaveLength(1)
    expect(body.transfers[0].amount).toBe('50.00')
    expect(body.page).toBe(1)
  })
})

describe('POST /api/routes-d/transfers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when recipientId is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/transfers/route')
    const res = await POST(postReq({ amount: 10 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when transferring to yourself', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/transfers/route')
    const res = await POST(postReq({ recipientId: 'user_1', amount: 10 }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when recipient does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockImplementation(async ({ where }: { where: { privyId?: string; id?: string } }) => {
      if (where.privyId) return { id: 'user_1' }
      return null
    })
    const { POST } = await import('@/app/api/routes-d/transfers/route')
    const res = await POST(postReq({ recipientId: 'user_999', amount: 10 }))
    expect(res.status).toBe(404)
  })

  it('returns 400 when amount exceeds ceiling', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockImplementation(async ({ where }: { where: { privyId?: string; id?: string } }) => {
      if (where.privyId) return { id: 'user_1' }
      return { id: 'user_2' }
    })
    const { POST } = await import('@/app/api/routes-d/transfers/route')
    const res = await POST(postReq({ recipientId: 'user_2', amount: 9_999_999 }))
    expect(res.status).toBe(400)
  })

  it('creates a transfer and returns 201', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockImplementation(async ({ where }: { where: { privyId?: string; id?: string } }) => {
      if (where.privyId) return { id: 'user_1' }
      return { id: 'user_2' }
    })
    txCreate.mockResolvedValue({
      id: 'tx1',
      type: 'transfer',
      status: 'pending',
      amount: { toString: () => '25.00' },
      currency: 'USD',
      externalId: 'ext1',
      createdAt: new Date(),
    })
    const { POST } = await import('@/app/api/routes-d/transfers/route')
    const res = await POST(postReq({ recipientId: 'user_2', amount: 25, currency: 'USD' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.transfer.amount).toBe('25.00')
  })
})
