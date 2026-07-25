import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const deviceFindMany = vi.fn()
const deviceCreate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    trustedDevice: { findMany: deviceFindMany, create: deviceCreate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))

const BASE_URL = 'http://localhost/api/routes-d/auth/trusted-devices'

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

async function importRoute() {
  return import('@/app/api/routes-d/auth/trusted-devices/route')
}

describe('GET /api/routes-d/auth/trusted-devices (#1229)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await importRoute()
    const response = await GET(makeGet({}))

    expect(response.status).toBe(401)
    expect(deviceFindMany).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeGet())

    expect(response.status).toBe(401)
  })

  it('returns 401 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeGet())

    expect(response.status).toBe(401)
  })

  it('lists the trusted devices for the user, newest first', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    deviceFindMany.mockResolvedValue([
      { id: 'dev_1', label: 'MacBook Pro', userAgent: 'Mozilla/5.0', ipAddress: '203.0.113.7', lastSeenAt: null, createdAt: new Date() },
    ])

    const { GET } = await importRoute()
    const response = await GET(makeGet())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.devices).toHaveLength(1)
    expect(body.devices[0]).toMatchObject({ id: 'dev_1', label: 'MacBook Pro' })
    expect(deviceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1' },
        orderBy: { createdAt: 'desc' },
      }),
    )
  })
})

describe('POST /api/routes-d/auth/trusted-devices (#1229)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
  })

  it('creates a trusted device and returns 201', async () => {
    deviceCreate.mockResolvedValue({
      id: 'dev_1',
      label: 'MacBook Pro',
      userAgent: 'Mozilla/5.0',
      ipAddress: '203.0.113.7',
      lastSeenAt: null,
      createdAt: new Date(),
    })

    const { POST } = await importRoute()
    const response = await POST(
      makePost({ label: 'MacBook Pro', userAgent: 'Mozilla/5.0', ipAddress: '203.0.113.7' }),
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.device).toMatchObject({ id: 'dev_1', label: 'MacBook Pro' })
    expect(deviceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          userId: 'user_1',
          label: 'MacBook Pro',
          userAgent: 'Mozilla/5.0',
          ipAddress: '203.0.113.7',
        },
      }),
    )
  })

  it('accepts a device with only a label', async () => {
    deviceCreate.mockResolvedValue({
      id: 'dev_2',
      label: 'Office desktop',
      userAgent: null,
      ipAddress: null,
      lastSeenAt: null,
      createdAt: new Date(),
    })

    const { POST } = await importRoute()
    const response = await POST(makePost({ label: 'Office desktop' }))

    expect(response.status).toBe(201)
    expect(deviceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userAgent: null, ipAddress: null }),
      }),
    )
  })

  it('returns 400 for invalid JSON', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost('not-json'))

    expect(response.status).toBe(400)
    expect(deviceCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when label is missing or empty', async () => {
    const { POST } = await importRoute()

    const missing = await POST(makePost({}))
    expect(missing.status).toBe(400)

    const empty = await POST(makePost({ label: '   ' }))
    expect(empty.status).toBe(400)

    expect(deviceCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when label exceeds 100 characters', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost({ label: 'x'.repeat(101) }))

    expect(response.status).toBe(400)
    expect(deviceCreate).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid ipAddress', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost({ label: 'Laptop', ipAddress: 'not-an-ip' }))

    expect(response.status).toBe(400)
    expect(deviceCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when userAgent exceeds 500 characters', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost({ label: 'Laptop', userAgent: 'x'.repeat(501) }))

    expect(response.status).toBe(400)
    expect(deviceCreate).not.toHaveBeenCalled()
  })

  it('returns 500 when the database write fails', async () => {
    deviceCreate.mockRejectedValue(new Error('db down'))

    const { POST } = await importRoute()
    const response = await POST(makePost({ label: 'Laptop' }))

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalled()
  })
})
