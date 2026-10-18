import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockPortalFindFirst = vi.fn()
const mockPortalFindMany = vi.fn()
const mockPortalCreate = vi.fn()
const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    clientPortalSession: {
      findFirst: (...args: unknown[]) => mockPortalFindFirst(...args),
      findMany: (...args: unknown[]) => mockPortalFindMany(...args),
      create: (...args: unknown[]) => mockPortalCreate(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: vi.fn(),
  },
}))

import {
  GET,
  POST,
  hashClientPortalToken,
  deriveClientPortalTokenHint,
  MAX_PORTAL_SESSION_TTL_SECONDS,
} from './route'

function makeRequest(
  url: string,
  options?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Client Portal Sessions API (/api/clients/[id]/portal-sessions)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({ id: 'user-1' })
    mockPortalFindFirst.mockResolvedValue(null)
    mockPortalFindMany.mockResolvedValue([])
  })

  it('returns 401 when unauthenticated', async () => {
    const req = makeRequest(
      'http://localhost/api/clients/client-1/portal-sessions',
    )
    const res = await POST(req, { params: { id: 'client-1' } })
    expect(res.status).toBe(401)
  })

  it('generates a raw token, persists only SHA-256 hashedToken and short tokenHint, and never logs the raw token', async () => {
    mockPortalCreate.mockImplementation(async ({ data }: any) => ({
      id: 'cps-1',
      ...data,
      lastSeenAt: null,
      revokedAt: null,
      createdAt: new Date('2026-04-01T10:00:00Z'),
    }))

    const req = makeRequest(
      'http://localhost/api/clients/client-1/portal-sessions',
      {
        token: 'valid-token',
        body: {},
      },
    )

    const res = await POST(req, { params: { id: 'client-1' } })
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.reusedExisting).toBe(false)
    expect(typeof json.token).toBe('string')
    expect(json.token.startsWith('cps_')).toBe(true)

    const expectedHash = hashClientPortalToken(json.token)
    const expectedHint = deriveClientPortalTokenHint(json.token)

    expect(expectedHint.length).toBeLessThanOrEqual(12)
    expect(json.session.hashedToken).toBe(expectedHash)
    expect(json.session.tokenHash).toBe(expectedHash)
    expect(json.session.tokenHint).toBe(expectedHint)
    expect(json.session.hashedToken).not.toBe(json.token)

    // Verify Prisma persistence payload never stores raw token
    const createCall = mockPortalCreate.mock.calls[0][0]
    expect(createCall.data.hashedToken).toBe(expectedHash)
    expect(createCall.data.tokenHint).toBe(expectedHint)
    expect(JSON.stringify(createCall)).not.toContain(json.token)

    // Verify logger never receives the raw token
    expect(JSON.stringify(mockLoggerInfo.mock.calls)).not.toContain(json.token)
  })

  it('returns the existing active non-revoked session instead of creating a duplicate', async () => {
    const futureExpiry = new Date(Date.now() + 3600 * 1000)
    mockPortalFindFirst.mockResolvedValue({
      id: 'cps-existing',
      userId: 'user-1',
      clientId: 'client-1',
      hashedToken: 'a'.repeat(64),
      tokenHint: 'cps_12345678',
      lastSeenAt: null,
      revokedAt: null,
      expiresAt: futureExpiry,
      createdAt: new Date('2026-04-01T09:00:00Z'),
    })

    const req = makeRequest(
      'http://localhost/api/clients/client-1/portal-sessions',
      {
        token: 'valid-token',
        body: {},
      },
    )

    const res = await POST(req, { params: { id: 'client-1' } })
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.reusedExisting).toBe(true)
    expect(json.session.id).toBe('cps-existing')
    expect(json.token).toBeUndefined()
    expect(mockPortalCreate).not.toHaveBeenCalled()
  })

  it('enforces bounded expiresAt (rejects non-positive or > 30 day TTL)', async () => {
    const reqTooLong = makeRequest(
      'http://localhost/api/clients/client-1/portal-sessions',
      {
        token: 'valid-token',
        body: { expiresInSeconds: MAX_PORTAL_SESSION_TTL_SECONDS + 3600 },
      },
    )

    const resTooLong = await POST(reqTooLong, { params: { id: 'client-1' } })
    expect(resTooLong.status).toBe(400)
    const jsonTooLong = await resTooLong.json()
    expect(jsonTooLong.code).toBe('INVALID_PORTAL_SESSION_EXPIRY')
    expect(mockPortalCreate).not.toHaveBeenCalled()
  })

  it('lists client portal sessions for the authenticated freelancer via GET', async () => {
    mockPortalFindMany.mockResolvedValue([
      {
        id: 'cps-1',
        userId: 'user-1',
        clientId: 'client-1',
        hashedToken: 'b'.repeat(64),
        tokenHint: 'cps_abcdef12',
        lastSeenAt: null,
        revokedAt: null,
        expiresAt: new Date('2026-04-08T10:00:00Z'),
        createdAt: new Date('2026-04-01T10:00:00Z'),
      },
    ])

    const req = makeRequest(
      'http://localhost/api/clients/client-1/portal-sessions',
      {
        method: 'GET',
        token: 'valid-token',
      },
    )

    const res = await GET(req, { params: { id: 'client-1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.total).toBe(1)
    expect(json.sessions[0].id).toBe('cps-1')
  })
})
