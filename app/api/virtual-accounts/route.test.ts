import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    virtualAccount: { findUnique: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const accountRow = {
  id: 'va-1',
  bankName: 'Wema Bank',
  accountNumber: '1234567890',
  accountName: 'LancePay / Ada',
  provider: 'paystack',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
}

const validBody = {
  bankName: 'Wema Bank',
  accountNumber: '1234567890',
  accountName: 'LancePay / Ada',
  provider: 'paystack',
  providerRef: 'ref-abc',
}

function getRequest(headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest('http://localhost/api/virtual-accounts', { method: 'GET', headers })
}

function postRequest(body: unknown, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest('http://localhost/api/virtual-accounts', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function uniqueError(target: unknown) {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } })
}

// findUnique is called by userId and by accountNumber; route on the `where` shape.
function mockLookups({ byUser = null, byNumber = null }: { byUser?: unknown; byNumber?: unknown } = {}) {
  vi.mocked(prisma.virtualAccount.findUnique).mockImplementation((async ({ where }: { where: Record<string, unknown> }) =>
    'userId' in where ? byUser : byNumber) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  mockLookups()
  vi.mocked(prisma.virtualAccount.create).mockResolvedValue(accountRow as never)
})

describe('GET /api/virtual-accounts', () => {
  it('returns the caller\'s virtual account without the internal providerRef', async () => {
    mockLookups({ byUser: accountRow })

    const res = await GET(getRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.virtualAccount.accountNumber).toBe('1234567890')
    expect(data.virtualAccount).not.toHaveProperty('providerRef')
    const args = vi.mocked(prisma.virtualAccount.findUnique).mock.calls[0]![0] as {
      where: unknown
      select: Record<string, boolean>
    }
    expect(args.where).toEqual({ userId: 'user-1' })
    expect(args.select).not.toHaveProperty('providerRef')
  })

  it('returns 404 when no account has been provisioned', async () => {
    const res = await GET(getRequest())
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    expect((await GET(getRequest({}))).status).toBe(401)
    vi.mocked(verifyAuthToken).mockResolvedValueOnce(null as never)
    expect((await GET(getRequest())).status).toBe(401)
  })

  it('returns 500 when the lookup fails', async () => {
    vi.mocked(prisma.virtualAccount.findUnique).mockRejectedValueOnce(new Error('db down'))
    expect((await GET(getRequest())).status).toBe(500)
  })
})

describe('POST /api/virtual-accounts', () => {
  it('provisions an account defaulting to active and storing providerRef', async () => {
    const res = await POST(postRequest(validBody))
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.created).toBe(true)
    expect(data.virtualAccount).not.toHaveProperty('providerRef')
    expect(prisma.virtualAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          userId: 'user-1',
          bankName: 'Wema Bank',
          accountNumber: '1234567890',
          accountName: 'LancePay / Ada',
          provider: 'paystack',
          providerRef: 'ref-abc',
          status: 'active',
        },
      }),
    )
  })

  it('stores a null providerRef when none is supplied', async () => {
    const withoutRef: Record<string, unknown> = { ...validBody }
    delete withoutRef.providerRef
    await POST(postRequest(withoutRef))
    expect(prisma.virtualAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ providerRef: null, status: 'active' }) }),
    )
  })

  it('ignores a client-supplied status and userId', async () => {
    await POST(postRequest({ ...validBody, status: 'suspended', userId: 'attacker' }))
    expect(prisma.virtualAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1', status: 'active' }) }),
    )
  })

  it('returns the existing account instead of erroring when one is already provisioned', async () => {
    mockLookups({ byUser: accountRow })

    const res = await POST(postRequest(validBody))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data).toMatchObject({ created: false, virtualAccount: { id: 'va-1' } })
    expect(prisma.virtualAccount.create).not.toHaveBeenCalled()
  })

  it('is idempotent even when the retry body is empty', async () => {
    mockLookups({ byUser: accountRow })
    const res = await POST(postRequest({}))
    expect(res.status).toBe(200)
  })

  it('returns a clean 409 when the account number belongs to another user', async () => {
    mockLookups({ byNumber: { id: 'va-other' } })

    const res = await POST(postRequest(validBody))

    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already in use/)
    expect(prisma.virtualAccount.create).not.toHaveBeenCalled()
  })

  it('maps a database unique violation on accountNumber to 409, not a 500', async () => {
    vi.mocked(prisma.virtualAccount.create).mockRejectedValueOnce(uniqueError(['accountNumber']))
    expect((await POST(postRequest(validBody))).status).toBe(409)
  })

  it('returns the winner\'s account when a concurrent request provisions the same user first', async () => {
    vi.mocked(prisma.virtualAccount.create).mockRejectedValueOnce(uniqueError(['userId']))
    vi.mocked(prisma.virtualAccount.findUnique)
      .mockResolvedValueOnce(null as never) // initial lookup by userId
      .mockResolvedValueOnce(null as never) // accountNumber check
      .mockResolvedValueOnce(accountRow as never) // re-read after the race

    const res = await POST(postRequest(validBody))

    expect(res.status).toBe(200)
    expect((await res.json()).created).toBe(false)
  })

  it.each([
    ['missing bankName', { ...validBody, bankName: undefined }, 'bankName is required'],
    ['blank accountNumber', { ...validBody, accountNumber: '  ' }, 'accountNumber is required'],
    ['missing accountName', { ...validBody, accountName: undefined }, 'accountName is required'],
    ['missing provider', { ...validBody, provider: undefined }, 'provider is required'],
    ['too-long bankName', { ...validBody, bankName: 'b'.repeat(101) }, 'bankName must be at most 100'],
    ['too-long accountNumber', { ...validBody, accountNumber: '1'.repeat(21) }, 'accountNumber must be at most 20'],
    ['accountNumber with symbols', { ...validBody, accountNumber: '12 34;DROP' }, 'letters, digits and hyphens'],
    ['too-long accountName', { ...validBody, accountName: 'a'.repeat(256) }, 'accountName must be at most 255'],
    ['too-long provider', { ...validBody, provider: 'p'.repeat(51) }, 'provider must be at most 50'],
    ['too-long providerRef', { ...validBody, providerRef: 'r'.repeat(256) }, 'providerRef must be at most 255'],
    ['non-string providerRef', { ...validBody, providerRef: 7 }, 'providerRef must be a string'],
    ['non-string bankName', { ...validBody, bankName: 5 }, 'bankName is required'],
  ])('rejects %s with 400', async (_label, body, message) => {
    const res = await POST(postRequest(body))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain(message)
    expect(prisma.virtualAccount.create).not.toHaveBeenCalled()
  })

  it('rejects invalid and non-object JSON bodies', async () => {
    expect((await POST(postRequest('{oops'))).status).toBe(400)
    expect((await POST(postRequest('[]'))).status).toBe(400)
  })

  it('returns 401 without authentication', async () => {
    const res = await POST(postRequest(validBody, {}))
    expect(res.status).toBe(401)
    expect(prisma.virtualAccount.create).not.toHaveBeenCalled()
  })

  it('returns 500 for unexpected database errors', async () => {
    vi.mocked(prisma.virtualAccount.create).mockRejectedValueOnce(new Error('connection lost'))
    const res = await POST(postRequest(validBody))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to provision virtual account' })
  })
})
