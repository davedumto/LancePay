import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    plaidAccount: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { GET, POST } from './route'

function makePostRequest(body: unknown, token: string | null = 'valid-token'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/integrations/plaid/accounts', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function makeGetRequest(token: string | null = 'valid-token'): NextRequest {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/integrations/plaid/accounts', {
    method: 'GET',
    headers,
  })
}

describe('POST /api/integrations/plaid/accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' })
    mockPrisma.plaidAccount.findUnique.mockResolvedValue(null)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(
      makePostRequest(
        {
          plaidItemId: 'item-1',
          plaidAccountId: 'acc-1',
          institutionName: 'Chase',
          accountName: 'Checking',
          type: 'depository',
        },
        null,
      ),
    )
    expect(res.status).toBe(401)
  })

  it('rejects unrecognized Plaid type or subtype with 400 instead of silently coercing', async () => {
    const badType = await POST(
      makePostRequest({
        plaidItemId: 'item-1',
        plaidAccountId: 'acc-1',
        institutionName: 'Chase',
        accountName: 'Checking',
        type: 'unknown_type',
      }),
    )
    expect(badType.status).toBe(400)
    const badTypeBody = await badType.json()
    expect(badTypeBody.error).toContain('Invalid Plaid account type')

    const badSubtype = await POST(
      makePostRequest({
        plaidItemId: 'item-1',
        plaidAccountId: 'acc-1',
        institutionName: 'Chase',
        accountName: 'Checking',
        type: 'depository',
        subtype: 'totally_invented_subtype',
      }),
    )
    expect(badSubtype.status).toBe(400)
    const badSubtypeBody = await badSubtype.json()
    expect(badSubtypeBody.error).toContain('Unrecognized Plaid account subtype')
  })

  it('returns 409 when plaidAccountId is already linked', async () => {
    mockPrisma.plaidAccount.findUnique.mockResolvedValueOnce({
      id: 'pa-existing',
      userId: 'user-1',
      plaidAccountId: 'acc-duplicate',
    })

    const res = await POST(
      makePostRequest({
        plaidItemId: 'item-1',
        plaidAccountId: 'acc-duplicate',
        institutionName: 'Chase',
        accountName: 'Checking',
        type: 'depository',
        subtype: 'checking',
      }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('PLAID_ACCOUNT_ALREADY_LINKED')
  })

  it('links a new Plaid account with status active and lastSyncedAt null', async () => {
    mockPrisma.plaidAccount.create.mockImplementationOnce(async ({ data }) => ({
      id: 'pa-new',
      createdAt: new Date('2026-03-01T10:00:00Z'),
      ...data,
    }))

    const res = await POST(
      makePostRequest({
        plaidItemId: 'item-123',
        plaidAccountId: 'plaid-acc-123',
        institutionName: 'Mercury',
        accountName: 'Operating Checking',
        mask: '9876',
        type: 'depository',
        subtype: 'checking',
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()

    expect(body.account).toMatchObject({
      id: 'pa-new',
      userId: 'user-1',
      plaidItemId: 'item-123',
      plaidAccountId: 'plaid-acc-123',
      institutionName: 'Mercury',
      accountName: 'Operating Checking',
      mask: '9876',
      type: 'depository',
      subtype: 'checking',
      status: 'active',
      lastSyncedAt: null,
    })
  })
})

describe('GET /api/integrations/plaid/accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' })
  })

  it('lists Plaid accounts belonging to the authenticated user', async () => {
    mockPrisma.plaidAccount.findMany.mockResolvedValueOnce([
      {
        id: 'pa-1',
        userId: 'user-1',
        plaidItemId: 'item-1',
        plaidAccountId: 'acc-1',
        institutionName: 'Mercury',
        accountName: 'Checking',
        mask: '9876',
        type: 'depository',
        subtype: 'checking',
        status: 'active',
        lastSyncedAt: null,
      },
    ])

    const res = await GET(makeGetRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accounts).toHaveLength(1)
    expect(body.accounts[0].lastSyncedAt).toBeNull()
  })
})
