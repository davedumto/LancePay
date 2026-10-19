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
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/proposals/proposal-1/signature-weight', {
    headers: { authorization: 'Bearer token' },
  })
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
    signatures: [{ signerId: 'user-1' }, { signerId: 'user-2' }],
  } as any)
  vi.mocked(prisma.walletSigner.findMany).mockResolvedValue([
    { userId: 'user-1', weight: 1 },
    { userId: 'user-2', weight: 2 },
  ] as any)
})

describe('GET proposal signature weight', () => {
  it('sums the associated signer weights against the wallet threshold', async () => {
    const response = await GET(makeRequest(), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      proposalId: 'proposal-1',
      currentWeight: 3,
      requiredThreshold: 3,
      thresholdMet: true,
    })
    expect(prisma.walletSigner.findMany).toHaveBeenCalledWith({
      where: { walletId: 'wallet-1', userId: { in: ['user-1', 'user-2'] } },
      select: { userId: true, weight: true },
    })
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
})