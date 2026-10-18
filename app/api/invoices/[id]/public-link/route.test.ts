import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  invoice: {
    findUnique: vi.fn(),
  },
  invoicePublicLink: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: mockLogger }))

import {
  GET,
  POST,
  DELETE,
  hashPublicLinkToken,
  MAX_PUBLIC_LINK_TTL_SECONDS,
} from './route'

describe('GET, POST, DELETE /api/invoices/[id]/public-link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:owner_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_owner_1' })
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv_500',
      userId: 'user_owner_1',
      invoiceNumber: 'INV-500',
      clientName: 'Client Co',
      description: 'Audit & Penetration Testing',
      amount: '2500.00',
      currency: 'USDC',
      status: 'pending',
    })
  })

  it('generates a raw token, stores only its SHA-256 hash and short tokenHint, and never stores or logs the raw token', async () => {
    let dbCreateData: Record<string, any> = {}
    mockPrisma.invoicePublicLink.create.mockImplementation(
      async ({ data }: { data: Record<string, any> }) => {
        dbCreateData = data
        return {
          id: 'plink_1',
          ...data,
          lastViewedAt: null,
          revokedAt: null,
          createdAt: new Date('2026-06-05T10:00:00.000Z'),
        }
      },
    )

    const postReq = new NextRequest(
      'http://localhost/api/invoices/inv_500/public-link',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ expiresInSeconds: 7 * 24 * 3600 }),
      },
    )

    const postRes = await POST(postReq, { params: { id: 'inv_500' } })
    expect(postRes.status).toBe(201)
    const postBody = await postRes.json()

    const rawToken: string = postBody.token
    expect(rawToken).toMatch(/^lpl_[a-f0-9]{48}$/)

    // DB create received hashedToken + short tokenHint (<= 12 chars), never rawToken
    expect(dbCreateData.hashedToken).toBe(hashPublicLinkToken(rawToken))
    expect(dbCreateData.tokenHint).toBe(rawToken.slice(0, 12))
    expect(dbCreateData.tokenHint.length).toBeLessThanOrEqual(12)
    expect(JSON.stringify(dbCreateData)).not.toContain(rawToken)

    // Logger never logged rawToken
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain(rawToken)
  })

  it('enforces bounded expiresAt and supports revocation via revokedAt', async () => {
    // Oversized TTL (> 90 days) is rejected with 400
    const excessiveTtlReq = new NextRequest(
      'http://localhost/api/invoices/inv_500/public-link',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expiresInSeconds: MAX_PUBLIC_LINK_TTL_SECONDS + 3600,
        }),
      },
    )
    const excessiveRes = await POST(excessiveTtlReq, {
      params: { id: 'inv_500' },
    })
    expect(excessiveRes.status).toBe(400)
    const excessiveBody = await excessiveRes.json()
    expect(excessiveBody.code).toBe('INVALID_PUBLIC_LINK_EXPIRY')

    // Revoke via DELETE sets revokedAt
    mockPrisma.invoicePublicLink.update.mockImplementation(
      async ({ data }: { data: { revokedAt: Date } }) => ({
        id: 'plink_1',
        invoiceId: 'inv_500',
        hashedToken: 'hash_abc',
        tokenHint: 'lpl_12345678',
        createdBy: 'user_owner_1',
        lastViewedAt: null,
        revokedAt: data.revokedAt,
        expiresAt: new Date(Date.now() + 86400_000),
        createdAt: new Date('2026-06-05T10:00:00.000Z'),
      }),
    )

    const delReq = new NextRequest(
      'http://localhost/api/invoices/inv_500/public-link?linkId=plink_1',
      {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const delRes = await DELETE(delReq, { params: { id: 'inv_500' } })
    expect(delRes.status).toBe(200)
    const delBody = await delRes.json()
    expect(delBody.revoked).toBe(true)
    expect(delBody.publicLink.revokedAt).toBeTruthy()
  })

  it('updates lastViewedAt whenever the public link is successfully resolved', async () => {
    const rawToken = 'lpl_abcdef0123456789abcdef0123456789abcdef0123456789'
    const expectedHash = hashPublicLinkToken(rawToken)

    mockPrisma.invoicePublicLink.findUnique.mockResolvedValueOnce({
      id: 'plink_resolve_1',
      invoiceId: 'inv_500',
      hashedToken: expectedHash,
      tokenHint: 'lpl_abcdef01',
      createdBy: 'user_owner_1',
      lastViewedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date('2026-06-05T10:00:00.000Z'),
      invoice: {
        id: 'inv_500',
        invoiceNumber: 'INV-500',
        clientName: 'Client Co',
        description: 'Audit & Penetration Testing',
        amount: '2500.00',
        currency: 'USDC',
        status: 'pending',
        dueDate: null,
      },
    })

    mockPrisma.invoicePublicLink.update.mockImplementation(
      async ({ data }: { data: { lastViewedAt: Date } }) => ({
        id: 'plink_resolve_1',
        invoiceId: 'inv_500',
        hashedToken: expectedHash,
        tokenHint: 'lpl_abcdef01',
        createdBy: 'user_owner_1',
        lastViewedAt: data.lastViewedAt,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date('2026-06-05T10:00:00.000Z'),
      }),
    )

    const resolveReq = new NextRequest(
      `http://localhost/api/invoices/inv_500/public-link?token=${rawToken}`,
      { method: 'GET' },
    )
    const resolveRes = await GET(resolveReq, { params: { id: 'inv_500' } })
    expect(resolveRes.status).toBe(200)
    const resolveBody = await resolveRes.json()

    expect(resolveBody.resolved).toBe(true)
    expect(resolveBody.publicLink.lastViewedAt).toBeTruthy()
    expect(mockPrisma.invoicePublicLink.update).toHaveBeenCalledWith({
      where: { id: 'plink_resolve_1' },
      data: { lastViewedAt: expect.any(Date) },
    })
  })
})
