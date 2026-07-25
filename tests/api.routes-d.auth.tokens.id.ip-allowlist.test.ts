import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const apiKeyFindFirst = vi.fn()
const allowlistFindMany = vi.fn()
const allowlistFindFirst = vi.fn()
const allowlistCreate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    apiKey: { findFirst: apiKeyFindFirst },
    apiKeyIpAllowlist: {
      findMany: allowlistFindMany,
      findFirst: allowlistFindFirst,
      create: allowlistCreate,
    },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))

const BASE_URL = 'http://localhost/api/routes-d/auth/tokens/key_1/ip-allowlist'

function makeGet(headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(BASE_URL, { method: 'GET', headers })
}

function makePost(body: unknown, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const routeParams = { params: Promise.resolve({ id: 'key_1' }) }

async function importRoute() {
  return import('@/app/api/routes-d/auth/tokens/[id]/ip-allowlist/route')
}

function authAsUser() {
  verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
  userFindUnique.mockResolvedValue({ id: 'user_1' })
  apiKeyFindFirst.mockResolvedValue({ id: 'key_1' })
}

describe('GET /api/routes-d/auth/tokens/[id]/ip-allowlist (#1227)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await importRoute()
    const response = await GET(makeGet({}), routeParams)

    expect(response.status).toBe(401)
    expect(allowlistFindMany).not.toHaveBeenCalled()
  })

  it('returns 404 when the token does not exist or belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    apiKeyFindFirst.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeGet(), routeParams)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'Token not found' })
    expect(apiKeyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'key_1', userId: 'user_1' } }),
    )
  })

  it('lists allowlist entries for the token', async () => {
    authAsUser()
    allowlistFindMany.mockResolvedValue([
      { id: 'entry_1', cidr: '203.0.113.0/24', label: 'Office', createdAt: new Date() },
    ])

    const { GET } = await importRoute()
    const response = await GET(makeGet(), routeParams)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({ cidr: '203.0.113.0/24', label: 'Office' })
    expect(allowlistFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { apiKeyId: 'key_1' } }),
    )
  })
})

describe('POST /api/routes-d/auth/tokens/[id]/ip-allowlist (#1227)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authAsUser()
  })

  it('adds a CIDR range to the allowlist and returns 201', async () => {
    allowlistFindFirst.mockResolvedValue(null)
    allowlistCreate.mockResolvedValue({
      id: 'entry_1',
      cidr: '203.0.113.0/24',
      label: 'Office',
      createdAt: new Date(),
    })

    const { POST } = await importRoute()
    const response = await POST(makePost({ cidr: '203.0.113.0/24', label: 'Office' }), routeParams)

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.entry).toMatchObject({ cidr: '203.0.113.0/24' })
    expect(allowlistCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { apiKeyId: 'key_1', cidr: '203.0.113.0/24', label: 'Office' },
      }),
    )
  })

  it('accepts a bare IPv4 address and an IPv6 CIDR', async () => {
    allowlistFindFirst.mockResolvedValue(null)
    allowlistCreate.mockResolvedValue({ id: 'e', cidr: 'x', label: null, createdAt: new Date() })

    const { POST } = await importRoute()

    const ipv4 = await POST(makePost({ cidr: '198.51.100.7' }), routeParams)
    expect(ipv4.status).toBe(201)

    const ipv6 = await POST(makePost({ cidr: '2001:db8::/32' }), routeParams)
    expect(ipv6.status).toBe(201)
  })

  it('returns 409 when the entry already exists', async () => {
    allowlistFindFirst.mockResolvedValue({ id: 'entry_1' })

    const { POST } = await importRoute()
    const response = await POST(makePost({ cidr: '203.0.113.0/24' }), routeParams)

    expect(response.status).toBe(409)
    expect(allowlistCreate).not.toHaveBeenCalled()
  })

  it('returns 400 for invalid JSON', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost('not-json'), routeParams)

    expect(response.status).toBe(400)
    expect(allowlistCreate).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    '',
    'not-an-ip',
    '203.0.113.0/33',
    '2001:db8::/129',
    '203.0.113.0/abc',
    '999.0.0.1',
  ])('returns 400 for invalid cidr %p', async (cidr) => {
    const { POST } = await importRoute()
    const response = await POST(makePost({ cidr }), routeParams)

    expect(response.status).toBe(400)
    expect(allowlistCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when label exceeds 100 characters', async () => {
    const { POST } = await importRoute()
    const response = await POST(
      makePost({ cidr: '203.0.113.1', label: 'x'.repeat(101) }),
      routeParams,
    )

    expect(response.status).toBe(400)
    expect(allowlistCreate).not.toHaveBeenCalled()
  })

  it('returns 500 when the database write fails', async () => {
    allowlistFindFirst.mockResolvedValue(null)
    allowlistCreate.mockRejectedValue(new Error('db down'))

    const { POST } = await importRoute()
    const response = await POST(makePost({ cidr: '203.0.113.1' }), routeParams)

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalled()
  })
})
