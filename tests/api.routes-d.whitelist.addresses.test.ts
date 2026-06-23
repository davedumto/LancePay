import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const whitelistFindMany = vi.fn()
const whitelistCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    whitelistAddress: { findMany: whitelistFindMany, create: whitelistCreate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/whitelist/addresses'

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

describe('GET /api/routes-d/whitelist/addresses', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/whitelist/addresses/route')
    const res = await GET(new NextRequest(URL))
    expect(res.status).toBe(401)
  })

  it('returns list of whitelisted addresses', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    whitelistFindMany.mockResolvedValue([
      { id: 'wa1', label: 'My wallet', address: 'GD...XYZ', network: 'stellar', createdAt: new Date() },
    ])
    const { GET } = await import('@/app/api/routes-d/whitelist/addresses/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.addresses).toHaveLength(1)
    expect(body.addresses[0].network).toBe('stellar')
  })
})

describe('POST /api/routes-d/whitelist/addresses', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when label is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/whitelist/addresses/route')
    const res = await POST(postReq({ address: 'GD...XYZ' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when address is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/whitelist/addresses/route')
    const res = await POST(postReq({ label: 'My wallet' }))
    expect(res.status).toBe(400)
  })

  it('creates address with default stellar network and returns 201', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    whitelistCreate.mockResolvedValue({
      id: 'wa2', label: 'Savings', address: 'GD...ABC', network: 'stellar', createdAt: new Date(),
    })
    const { POST } = await import('@/app/api/routes-d/whitelist/addresses/route')
    const res = await POST(postReq({ label: 'Savings', address: 'GD...ABC' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.address.network).toBe('stellar')
  })

  it('returns 409 on duplicate address (Prisma P2002)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const err = Object.assign(new Error('unique'), { code: 'P2002' })
    whitelistCreate.mockRejectedValue(err)
    const { POST } = await import('@/app/api/routes-d/whitelist/addresses/route')
    const res = await POST(postReq({ label: 'Dup', address: 'GD...DUP' }))
    expect(res.status).toBe(409)
  })
})
