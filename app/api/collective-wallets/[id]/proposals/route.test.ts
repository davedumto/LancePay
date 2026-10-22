import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Keypair } from '@stellar/stellar-sdk'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    multisigProposal: { findMany: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const WALLET_ADDRESS = Keypair.random().publicKey()
const DESTINATION = Keypair.random().publicKey()
const NOW = new Date('2026-10-15T12:00:00Z')
const ctx = () => ({ params: Promise.resolve({ id: 'wallet-1' }) })

function makeRequest(method: 'GET' | 'POST', body?: unknown, query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/collective-wallets/wallet-1/proposals${query}`, {
    method,
    headers: { authorization: 'Bearer token' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function createData() {
  return vi.mocked(prisma.multisigProposal.create).mock.calls[0][0].data as any
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'a@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1',
    stellarAddress: WALLET_ADDRESS,
    threshold: 2,
    signers: [{ id: 'ws-1' }],
  } as any)
  vi.mocked(prisma.multisigProposal.create).mockImplementation(
    (async (args: any) =>
      ({
        id: 'prop-1',
        ...args.data,
        amountUsdc: args.data.amountUsdc.toString(),
        proposer: { id: 'user-1', name: 'Ada', email: 'a@example.com' },
        _count: { signatures: 0 },
      }) as any) as any
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/collective-wallets/[id]/proposals', () => {
  it('lists the wallet proposals newest first', async () => {
    vi.mocked(prisma.multisigProposal.findMany).mockResolvedValue([{ id: 'prop-1' }] as any)
    const res = await GET(makeRequest('GET'), ctx())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.proposals).toHaveLength(1)
    expect(data.threshold).toBe(2)
    expect(prisma.multisigProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: 'wallet-1' }, orderBy: { createdAt: 'desc' } })
    )
  })

  it('filters by status', async () => {
    vi.mocked(prisma.multisigProposal.findMany).mockResolvedValue([])
    await GET(makeRequest('GET', undefined, '?status=pending'), ctx())
    expect(prisma.multisigProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: 'wallet-1', status: 'pending' } })
    )
  })

  it('returns 403 for a non-signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1',
      stellarAddress: WALLET_ADDRESS,
      threshold: 2,
      signers: [],
    } as any)
    const res = await GET(makeRequest('GET'), ctx())
    expect(res.status).toBe(403)
    expect(prisma.multisigProposal.findMany).not.toHaveBeenCalled()
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await GET(makeRequest('GET'), ctx())
    expect(res.status).toBe(401)
  })
})

describe('POST /api/collective-wallets/[id]/proposals', () => {
  it('creates a pending proposal with the default expiry and returns the proposer', async () => {
    const res = await POST(
      makeRequest('POST', { destinationAddress: DESTINATION, amountUsdc: '125.50', memo: 'invoice 42' }),
      ctx()
    )
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.proposal.proposer).toEqual({ id: 'user-1', name: 'Ada', email: 'a@example.com' })
    expect(data.proposal.status).toBe('pending')

    const created = createData()
    expect(created).toMatchObject({
      walletId: 'wallet-1',
      proposerId: 'user-1',
      destinationAddress: DESTINATION,
      memo: 'invoice 42',
      status: 'pending',
    })
    expect(created.amountUsdc.toString()).toBe('125.5')
    expect(created.expiresAt).toEqual(new Date(NOW.getTime() + 72 * 60 * 60 * 1000))
    expect(vi.mocked(prisma.multisigProposal.create).mock.calls[0][0].select).toHaveProperty('proposer')
  })

  it('accepts a numeric amount and a custom expiry window', async () => {
    const res = await POST(
      makeRequest('POST', { destinationAddress: DESTINATION, amountUsdc: 10, expiresInHours: 24 }),
      ctx()
    )
    expect(res.status).toBe(201)
    expect(createData().amountUsdc.toString()).toBe('10')
    expect(createData().expiresAt).toEqual(new Date(NOW.getTime() + 24 * 60 * 60 * 1000))
  })

  it.each([0, 169, 1.5])('rejects expiresInHours %p outside the bounded window', async (expiresInHours) => {
    const res = await POST(
      makeRequest('POST', { destinationAddress: DESTINATION, amountUsdc: '1', expiresInHours }),
      ctx()
    )
    expect(res.status).toBe(400)
    expect((await res.json()).details.expiresInHours).toBeDefined()
  })

  it.each(['0', '-5', 0, -1, 'abc', '1.1234567', '1e3', 'NaN', ''])('rejects amountUsdc %p', async (amountUsdc) => {
    const res = await POST(makeRequest('POST', { destinationAddress: DESTINATION, amountUsdc }), ctx())
    expect(res.status).toBe(400)
    expect(prisma.multisigProposal.create).not.toHaveBeenCalled()
  })

  it('rejects an invalid destination address', async () => {
    const res = await POST(
      makeRequest('POST', { destinationAddress: 'GNOTVALIDADDRESS', amountUsdc: '1' }),
      ctx()
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Invalid Stellar address')
  })

  it('rejects a secret key passed as the destination', async () => {
    const res = await POST(
      makeRequest('POST', { destinationAddress: Keypair.random().secret(), amountUsdc: '1' }),
      ctx()
    )
    expect(res.status).toBe(400)
  })

  it('rejects paying the wallet itself', async () => {
    const res = await POST(makeRequest('POST', { destinationAddress: WALLET_ADDRESS, amountUsdc: '1' }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('wallet itself')
  })

  it('rejects a memo longer than 28 bytes', async () => {
    const res = await POST(
      makeRequest('POST', { destinationAddress: DESTINATION, amountUsdc: '1', memo: 'x'.repeat(29) }),
      ctx()
    )
    expect(res.status).toBe(400)
    expect((await res.json()).details.memo).toBeDefined()
  })

  it('returns 403 when the caller is not a signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1',
      stellarAddress: WALLET_ADDRESS,
      threshold: 2,
      signers: [],
    } as any)
    const res = await POST(makeRequest('POST', { destinationAddress: DESTINATION, amountUsdc: '1' }), ctx())
    expect(res.status).toBe(403)
    expect(prisma.multisigProposal.create).not.toHaveBeenCalled()
  })

  it('returns 404 when the wallet does not exist', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest('POST', { destinationAddress: DESTINATION, amountUsdc: '1' }), ctx())
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makeRequest('POST', { destinationAddress: DESTINATION, amountUsdc: '1' }), ctx())
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected errors', async () => {
    vi.mocked(prisma.multisigProposal.create).mockRejectedValue(new Error('db down'))
    const res = await POST(makeRequest('POST', { destinationAddress: DESTINATION, amountUsdc: '1' }), ctx())
    expect(res.status).toBe(500)
  })
})
