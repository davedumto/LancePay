import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const methodFindMany = vi.fn()
const methodCreate = vi.fn()
const methodCount = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    payoutMethod: { findMany: methodFindMany, create: methodCreate, count: methodCount },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/payout-methods'

function getReq(token: string | null = 'tok') {
  const h = new Headers()
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'GET', headers: h })
}

function postReq(body: object, token: string | null = 'tok') {
  const h = new Headers({ 'content-type': 'application/json' })
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'POST', headers: h, body: JSON.stringify(body) })
}

describe('GET /api/routes-d/payout-methods', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with no token', async () => {
    const { GET } = await import('@/app/api/routes-d/payout-methods/route')
    const res = await GET(getReq(null))
    expect(res.status).toBe(401)
  })

  it('returns list of payout methods', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    methodFindMany.mockResolvedValue([
      { id: 'm1', type: 'bank', label: 'My Bank', isDefault: true, createdAt: new Date() },
    ])
    const { GET } = await import('@/app/api/routes-d/payout-methods/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.payoutMethods).toHaveLength(1)
  })
})

describe('POST /api/routes-d/payout-methods', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 422 when type missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    const { POST } = await import('@/app/api/routes-d/payout-methods/route')
    const res = await POST(postReq({ label: 'bank' }))
    expect(res.status).toBe(422)
  })

  it('creates a payout method and returns 201', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    methodCount.mockResolvedValue(0)
    methodCreate.mockResolvedValue({
      id: 'm1', type: 'bank', label: 'My Bank', isDefault: true, createdAt: new Date(),
    })
    const { POST } = await import('@/app/api/routes-d/payout-methods/route')
    const res = await POST(postReq({ type: 'bank', label: 'My Bank' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.payoutMethod.isDefault).toBe(true)
  })
})
