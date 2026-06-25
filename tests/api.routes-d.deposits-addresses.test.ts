import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const walletFindUnique = vi.fn()
const addressFindMany = vi.fn()
const addressCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    wallet: { findUnique: walletFindUnique },
    depositAddress: { findMany: addressFindMany, create: addressCreate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/deposits/addresses'

function getReq(token = 'tok') {
  return new NextRequest(URL, { method: 'GET', headers: { authorization: `Bearer ${token}` } })
}
function postReq(body: object) {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-d/deposits/addresses', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with no token', async () => {
    const { GET } = await import('@/app/api/routes-d/deposits/addresses/route')
    const res = await GET(new NextRequest(URL, { method: 'GET' }))
    expect(res.status).toBe(401)
  })

  it('returns address list', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    addressFindMany.mockResolvedValue([
      { id: 'a1', address: 'GABC', network: 'testnet', label: null, createdAt: new Date() },
    ])
    const { GET } = await import('@/app/api/routes-d/deposits/addresses/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.addresses).toHaveLength(1)
  })
})

describe('POST /api/routes-d/deposits/addresses', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 422 for invalid network', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    const { POST } = await import('@/app/api/routes-d/deposits/addresses/route')
    const res = await POST(postReq({ network: 'banana' }))
    expect(res.status).toBe(422)
  })

  it('generates deposit address and returns 201', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    walletFindUnique.mockResolvedValue({ address: 'GABC123' })
    addressCreate.mockResolvedValue({ id: 'a1', address: 'GABC123', network: 'testnet', label: null, createdAt: new Date() })
    const { POST } = await import('@/app/api/routes-d/deposits/addresses/route')
    const res = await POST(postReq({ network: 'testnet' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.address.address).toBe('GABC123')
  })
})
