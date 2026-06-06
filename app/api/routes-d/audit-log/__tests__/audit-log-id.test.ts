import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditEvent: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../[id]/route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedAuditFindUnique = vi.mocked(prisma.auditEvent.findUnique)

const user = { id: 'user-1', privyId: 'privy-1' }

function makeRequest(authHeader = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/audit-log/evt-1', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

const params = { params: Promise.resolve({ id: 'evt-1' }) }

describe('GET /api/routes-d/audit-log/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 401 when no bearer token is supplied', async () => {
    const res = await GET(makeRequest(''), params)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the bearer token does not verify', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user cannot be resolved from claims', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(null as never)
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(404)
  })

  it('returns 404 when the audit event does not exist', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(user as never)
    mockedAuditFindUnique.mockResolvedValue(null as never)
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(404)
  })

  it('returns 403 when the audit event was written by another actor', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(user as never)
    mockedAuditFindUnique.mockResolvedValue({
      id: 'evt-1',
      eventType: 'invoice.created',
      invoiceId: 'inv-1',
      actorId: 'user-2',
      metadata: { ip: '127.0.0.1' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as never)
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(403)
  })

  it('returns the mapped audit event for the owning actor', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(user as never)
    mockedAuditFindUnique.mockResolvedValue({
      id: 'evt-1',
      eventType: 'invoice.created',
      invoiceId: 'inv-1',
      actorId: user.id,
      metadata: { ip: '127.0.0.1', userAgent: 'jest/9' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as never)

    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.event).toMatchObject({
      id: 'evt-1',
      action: 'invoice.created',
      resourceType: 'invoice',
      resourceId: 'inv-1',
      ipAddress: '127.0.0.1',
      userAgent: 'jest/9',
    })
  })
})
