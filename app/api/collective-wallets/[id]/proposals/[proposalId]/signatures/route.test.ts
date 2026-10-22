import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    multisigProposal: { findFirst: vi.fn() },
    walletSigner: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { GET } from './route'

const context = { params: Promise.resolve({ id: 'wallet-1', proposalId: 'proposal-1' }) }

function makeRequest() {
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/proposals/proposal-1/signatures', {
    headers: { authorization: 'Bearer token' },
  })
}

function makeSignature(n: number) {
  return {
    id: `sig-${n}`,
    signerId: `user-${n}`,
    createdAt: new Date(`2026-01-01T00:0${n}:00Z`),
    signer: { id: `user-${n}`, name: `User ${n}`, email: `u${n}@example.com` },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'a@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1',
    stellarAddress: 'G'.padEnd(56, 'A'),
    threshold: 3,
    signers: [{ id: 'wallet-signer-1' }],
  } as any)
  vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
    id: 'proposal-1',
    signatures: [makeSignature(1), makeSignature(2), makeSignature(3)],
  } as any)
  vi.mocked(prisma.walletSigner.findMany).mockResolvedValue([
    { userId: 'user-1', weight: 1 },
    { userId: 'user-2', weight: 2 },
  ] as any)
})

describe('GET proposal signatures', () => {
  it('returns signatures oldest first with weight and running total toward the threshold', async () => {
    const response = await GET(makeRequest(), context)
    expect(response.status).toBe(200)
    const body = await response.json()

    expect(prisma.multisigProposal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proposal-1', walletId: 'wallet-1' },
        select: expect.objectContaining({
          signatures: expect.objectContaining({ orderBy: { createdAt: 'asc' } }),
        }),
      })
    )
    expect(body.signatures.map((s: any) => [s.id, s.weight, s.cumulativeWeight, s.thresholdMet])).toEqual([
      ['sig-1', 1, 1, false],
      ['sig-2', 2, 3, true],
      ['sig-3', 0, 3, true],
    ])
    expect(body.signatures[0].signer).toEqual({ id: 'user-1', name: 'User 1', email: 'u1@example.com' })
    expect(body).toMatchObject({ proposalId: 'proposal-1', currentWeight: 3, requiredThreshold: 3, thresholdMet: true })
  })

  it('marks a signer removed from the wallet as inactive with zero weight', async () => {
    const body = await (await GET(makeRequest(), context)).json()
    expect(body.signatures[2]).toMatchObject({ id: 'sig-3', weight: 0, activeSigner: false })
    expect(body.signatures[0].activeSigner).toBe(true)
  })

  it('returns an empty list for an unsigned proposal', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({ id: 'proposal-1', signatures: [] } as any)
    const body = await (await GET(makeRequest(), context)).json()
    expect(body).toMatchObject({ signatures: [], currentWeight: 0, thresholdMet: false })
    expect(prisma.walletSigner.findMany).not.toHaveBeenCalled()
  })

  it('returns 403 to a user who is not a wallet signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1', stellarAddress: 'G'.padEnd(56, 'A'), threshold: 3, signers: [],
    } as any)
    const response = await GET(makeRequest(), context)
    expect(response.status).toBe(403)
    expect(prisma.multisigProposal.findFirst).not.toHaveBeenCalled()
  })

  it('returns 404 for a proposal outside the wallet', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(null)
    const response = await GET(makeRequest(), context)
    expect(response.status).toBe(404)
  })

  it('returns 500 when the database fails', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockRejectedValue(new Error('db down'))
    const response = await GET(makeRequest(), context)
    expect(response.status).toBe(500)
  })
})
