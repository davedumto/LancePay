import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    multisigProposal: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    proposalSignature: { create: vi.fn(), findMany: vi.fn() },
    walletSigner: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/crypto', () => ({ decrypt: vi.fn(() => 'S-SECRET') }))
vi.mock('@/lib/stellar', () => ({ submitMultisigPaymentWithRetry: vi.fn() }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { submitMultisigPaymentWithRetry } from '@/lib/stellar'
import { POST } from './route'

const context = { params: Promise.resolve({ id: 'wallet-1', proposalId: 'proposal-1' }) }

function makeRequest() {
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/proposals/proposal-1/sign', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  })
}

function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proposal-1',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    destinationAddress: 'G'.padEnd(56, 'B'),
    amountUsdc: { toString: () => '25.5' },
    memo: 'rent',
    wallet: { encryptedSecretKey: 'encrypted' },
    ...overrides,
  }
}

/** Signatures already on the proposal (including the new one) and their wallet weights. */
function mockWeights(weights: number[]) {
  vi.mocked(prisma.proposalSignature.findMany).mockResolvedValue(
    weights.map((_, i) => ({ signerId: `user-${i + 1}` })) as any
  )
  vi.mocked(prisma.walletSigner.findMany).mockResolvedValue(weights.map((weight) => ({ weight })) as any)
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
  vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(makeProposal() as any)
  vi.mocked(prisma.proposalSignature.create).mockResolvedValue({
    id: 'sig-1', signerId: 'user-1', createdAt: new Date('2026-01-01T00:00:00Z'),
  } as any)
  vi.mocked(prisma.multisigProposal.updateMany).mockResolvedValue({ count: 1 } as any)
  vi.mocked(prisma.multisigProposal.update).mockResolvedValue({} as any)
  vi.mocked(submitMultisigPaymentWithRetry).mockResolvedValue('tx-hash-1')
  mockWeights([1])
})

describe('POST sign proposal', () => {
  it('records a signature and stays pending below the threshold', async () => {
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      signature: { id: 'sig-1', signerId: 'user-1' },
      currentWeight: 1,
      requiredThreshold: 3,
      thresholdMet: false,
      status: 'pending',
    })
    expect(prisma.proposalSignature.create).toHaveBeenCalledWith({
      data: { proposalId: 'proposal-1', signerId: 'user-1' },
      select: { id: true, signerId: true, createdAt: true },
    })
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
    expect(submitMultisigPaymentWithRetry).not.toHaveBeenCalled()
  })

  it('claims execution atomically and executes once threshold weight is met', async () => {
    mockWeights([1, 2])
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      currentWeight: 3,
      thresholdMet: true,
      status: 'executed',
      stellarTxHash: 'tx-hash-1',
    })
    expect(prisma.multisigProposal.updateMany).toHaveBeenCalledWith({
      where: { id: 'proposal-1', status: 'pending', expiresAt: { gt: expect.any(Date) } },
      data: { status: 'executing', executionStartedAt: expect.any(Date) },
    })
    expect(submitMultisigPaymentWithRetry).toHaveBeenCalledWith('S-SECRET', 'G'.padEnd(56, 'B'), '25.5', 'rent')
    expect(prisma.multisigProposal.update).toHaveBeenCalledWith({
      where: { id: 'proposal-1' },
      data: { status: 'executed', stellarTxHash: 'tx-hash-1', executedAt: expect.any(Date), lastError: null },
    })
  })

  it('does not execute twice when a concurrent signer already claimed execution', async () => {
    mockWeights([2, 2])
    vi.mocked(prisma.multisigProposal.updateMany).mockResolvedValue({ count: 0 } as any)
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(201)
    expect((await response.json()).status).toBe('executing')
    expect(submitMultisigPaymentWithRetry).not.toHaveBeenCalled()
    expect(prisma.multisigProposal.update).not.toHaveBeenCalled()
  })

  it('releases the claim and records lastError when submission fails', async () => {
    mockWeights([3])
    vi.mocked(submitMultisigPaymentWithRetry).mockRejectedValue(new Error('tx_bad_seq'))
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ status: 'pending', lastError: 'tx_bad_seq' })
    expect(prisma.multisigProposal.update).toHaveBeenCalledWith({
      where: { id: 'proposal-1' },
      data: { status: 'pending', lastError: 'tx_bad_seq' },
    })
  })

  it('records the signature but does not claim when the wallet has no signing key', async () => {
    mockWeights([3])
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(
      makeProposal({ wallet: { encryptedSecretKey: null } }) as any
    )
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(201)
    expect((await response.json()).status).toBe('pending')
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
  })

  it('rejects double-signing with 409', async () => {
    vi.mocked(prisma.proposalSignature.create).mockRejectedValue({ code: 'P2002' })
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('ALREADY_SIGNED')
  })

  it('rejects an expired proposal', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(
      makeProposal({ expiresAt: new Date(Date.now() - 1000) }) as any
    )
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('PROPOSAL_EXPIRED')
    expect(prisma.proposalSignature.create).not.toHaveBeenCalled()
  })

  it.each(['executing', 'executed'])('rejects a proposal that is %s', async (status) => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(makeProposal({ status }) as any)
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('ALREADY_EXECUTED')
    expect(prisma.proposalSignature.create).not.toHaveBeenCalled()
  })

  it('rejects a cancelled proposal', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(makeProposal({ status: 'cancelled' }) as any)
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(409)
    expect(prisma.proposalSignature.create).not.toHaveBeenCalled()
  })

  it('returns 403 to a user who is not a wallet signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1', stellarAddress: 'G'.padEnd(56, 'A'), threshold: 3, signers: [],
    } as any)
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(403)
    expect(prisma.proposalSignature.create).not.toHaveBeenCalled()
  })

  it('returns 404 for a proposal outside the wallet', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(null)
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(404)
  })

  it('returns 500 on unexpected database errors', async () => {
    vi.mocked(prisma.proposalSignature.create).mockRejectedValue(new Error('db down'))
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(500)
  })
})
