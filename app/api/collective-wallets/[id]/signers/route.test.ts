import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    walletSigner: { findMany: vi.fn(), findUnique: vi.fn(), aggregate: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const actor = { id: 'user-1', email: 'a@example.com' }
const ctx = () => ({ params: Promise.resolve({ id: 'wallet-1' }) })

function makeRequest(method: 'GET' | 'POST', body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/signers', {
    method,
    headers: { authorization: 'Bearer token' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function walletWith(signers: { id: string }[], threshold = 2) {
  return { id: 'wallet-1', stellarAddress: 'GADDR', threshold, signers }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockImplementation((async (args: any) =>
    args.where.privyId ? (actor as any) : ({ id: args.where.id } as any)) as any
  )
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(walletWith([{ id: 'ws-1' }]) as any)
  vi.mocked(prisma.walletSigner.findUnique).mockResolvedValue(null)
  vi.mocked(prisma.walletSigner.aggregate).mockResolvedValue({
    _sum: { weight: 2 },
    _count: { _all: 2 },
  } as any)
  vi.mocked(prisma.walletSigner.create).mockImplementation(
    (async (args: any) => ({ id: 'ws-new', ...args.data }) as any) as any
  )
})

describe('GET /api/collective-wallets/[id]/signers', () => {
  it('lists signers with total weight and threshold', async () => {
    vi.mocked(prisma.walletSigner.findMany).mockResolvedValue([
      { id: 'ws-1', userId: 'user-1', weight: 1 },
      { id: 'ws-2', userId: 'user-2', weight: 3 },
    ] as any)

    const res = await GET(makeRequest('GET'), ctx())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.signers).toHaveLength(2)
    expect(data.totalWeight).toBe(4)
    expect(data.threshold).toBe(2)
    expect(prisma.walletSigner.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: 'wallet-1' } })
    )
  })

  it('returns 403 for a non-signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(walletWith([]) as any)
    const res = await GET(makeRequest('GET'), ctx())
    expect(res.status).toBe(403)
    expect(prisma.walletSigner.findMany).not.toHaveBeenCalled()
  })

  it('returns 404 when the wallet does not exist', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), ctx())
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('WALLET_NOT_FOUND')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await GET(makeRequest('GET'), ctx())
    expect(res.status).toBe(401)
  })
})

describe('POST /api/collective-wallets/[id]/signers', () => {
  it('adds a signer with the given weight', async () => {
    const res = await POST(makeRequest('POST', { userId: 'user-2', weight: 3 }), ctx())
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.signer.userId).toBe('user-2')
    expect(data.totalWeight).toBe(5)
    expect(prisma.walletSigner.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { walletId: 'wallet-1', userId: 'user-2', weight: 3 } })
    )
  })

  it('defaults weight to 1', async () => {
    await POST(makeRequest('POST', { userId: 'user-2' }), ctx())
    expect(vi.mocked(prisma.walletSigner.create).mock.calls[0][0].data.weight).toBe(1)
  })

  it.each([0, -2, 1.5, '2'])('rejects weight %p', async (weight) => {
    const res = await POST(makeRequest('POST', { userId: 'user-2', weight }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).details.weight).toBeDefined()
    expect(prisma.walletSigner.create).not.toHaveBeenCalled()
  })

  it('returns 409 for a duplicate signer', async () => {
    vi.mocked(prisma.walletSigner.findUnique).mockResolvedValue({ id: 'ws-2' } as any)
    const res = await POST(makeRequest('POST', { userId: 'user-2' }), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('DUPLICATE_SIGNER')
    expect(prisma.walletSigner.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId_userId: { walletId: 'wallet-1', userId: 'user-2' } } })
    )
  })

  it('returns 409 when the unique index rejects a concurrent duplicate', async () => {
    vi.mocked(prisma.walletSigner.create).mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    )
    const res = await POST(makeRequest('POST', { userId: 'user-2' }), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('DUPLICATE_SIGNER')
  })

  it('rejects when total weight still cannot satisfy the threshold', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(walletWith([{ id: 'ws-1' }], 10) as any)
    const res = await POST(makeRequest('POST', { userId: 'user-2', weight: 1 }), ctx())
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('QUORUM_VIOLATION')
    expect(data.details).toEqual({ totalWeight: 3, threshold: 10 })
  })

  it('rejects when the wallet already has the maximum number of signers', async () => {
    vi.mocked(prisma.walletSigner.aggregate).mockResolvedValue({
      _sum: { weight: 20 },
      _count: { _all: 20 },
    } as any)
    const res = await POST(makeRequest('POST', { userId: 'user-2' }), ctx())
    expect(res.status).toBe(400)
  })

  it('returns 403 when the caller is not a signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(walletWith([]) as any)
    const res = await POST(makeRequest('POST', { userId: 'user-2' }), ctx())
    expect(res.status).toBe(403)
    expect(prisma.walletSigner.create).not.toHaveBeenCalled()
  })

  it('returns 404 when the user to add does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: any) =>
      args.where.privyId ? (actor as any) : null) as any
    )
    const res = await POST(makeRequest('POST', { userId: 'ghost' }), ctx())
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('USER_NOT_FOUND')
  })

  it('returns 404 when the wallet does not exist', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest('POST', { userId: 'user-2' }), ctx())
    expect(res.status).toBe(404)
  })

  it('returns 400 for a missing userId', async () => {
    const res = await POST(makeRequest('POST', { weight: 1 }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).details.userId).toBeDefined()
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makeRequest('POST', { userId: 'user-2' }), ctx())
    expect(res.status).toBe(401)
  })
})
