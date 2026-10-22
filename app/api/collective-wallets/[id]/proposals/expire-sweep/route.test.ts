import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Keypair } from '@stellar/stellar-sdk'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    multisigProposal: { updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const WALLET_ADDRESS = Keypair.random().publicKey()
const NOW = new Date('2026-10-15T12:00:00Z')
const ctx = (id = 'wallet-1') => ({ params: Promise.resolve({ id }) })

function makeRequest(token: string | null = 'valid-token'): NextRequest {
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/proposals/expire-sweep', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockImplementation(async (token: string) =>
    token === 'valid-token' ? ({ userId: 'privy-1' } as any) : null
  )
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'a@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1',
    stellarAddress: WALLET_ADDRESS,
    threshold: 2,
    signers: [{ id: 'ws-1' }],
  } as any)
  vi.mocked(prisma.multisigProposal.updateMany).mockResolvedValue({ count: 3 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/collective-wallets/[id]/proposals/expire-sweep', () => {
  it('transitions past-due pending proposals to expired and returns the count', async () => {
    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.count).toBe(3)
    expect(data.expiredCount).toBe(3)

    expect(prisma.multisigProposal.updateMany).toHaveBeenCalledWith({
      where: {
        walletId: 'wallet-1',
        status: 'pending',
        expiresAt: { lte: NOW },
      },
      data: {
        status: 'expired',
      },
    })
  })

  it('is idempotent and returns 0 count when no proposals need expiration', async () => {
    vi.mocked(prisma.multisigProposal.updateMany).mockResolvedValue({ count: 0 })

    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.count).toBe(0)
    expect(data.expiredCount).toBe(0)
  })

  it('leaves executing and other non-pending proposals untouched by filtering strictly on status pending', async () => {
    await POST(makeRequest(), ctx())

    const callArgs = vi.mocked(prisma.multisigProposal.updateMany).mock.calls[0][0]
    expect(callArgs.where).toEqual({
      walletId: 'wallet-1',
      status: 'pending',
      expiresAt: { lte: NOW },
    })
    expect(callArgs.where?.status).toBe('pending')
  })

  it('rejects unauthenticated requests', async () => {
    const res = await POST(makeRequest(null), ctx())
    expect(res.status).toBe(401)
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
  })

  it('rejects invalid auth token', async () => {
    const res = await POST(makeRequest('invalid-token'), ctx())
    expect(res.status).toBe(401)
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
  })

  it('returns 404 when the user does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(404)
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
  })

  it('returns 404 when the wallet does not exist', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(404)
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
  })

  it('returns 403 when the caller is not a signer of the wallet', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1',
      stellarAddress: WALLET_ADDRESS,
      threshold: 2,
      signers: [],
    } as any)
    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(403)
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
  })

  it('returns 400 when wallet id is empty', async () => {
    const res = await POST(makeRequest(), ctx('   '))
    expect(res.status).toBe(400)
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
  })

  it('returns 500 when database update fails', async () => {
    vi.mocked(prisma.multisigProposal.updateMany).mockRejectedValue(new Error('DB failure'))
    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Failed to expire stale proposals')
  })
})
