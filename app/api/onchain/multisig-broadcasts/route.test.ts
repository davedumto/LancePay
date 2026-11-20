import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    multisigProposal: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    walletSigner: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/crypto', () => ({ decrypt: vi.fn(() => 'S_DECRYPTED_SECRET') }))
vi.mock('@/lib/stellar', () => ({ submitMultisigPaymentWithRetry: vi.fn() }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { submitMultisigPaymentWithRetry } from '@/lib/stellar'

const mockActor = { id: 'user-1', email: 'signer@example.com', role: 'freelancer' }
const mockClaims = { userId: 'privy-1' }

function makeWallet(overrides: Partial<any> = {}) {
  return {
    id: 'wallet-1',
    threshold: 2,
    encryptedSecretKey: 'iv:encrypted',
    ...overrides,
  }
}

function makeProposal(overrides: Partial<any> = {}) {
  return {
    id: 'proposal-1',
    walletId: 'wallet-1',
    destinationAddress: 'GDESTADDRESS',
    amountUsdc: { toString: () => '100' },
    memo: 'invoice-42',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    stellarTxHash: null,
    wallet: makeWallet(),
    signatures: [{ id: 'sig-1' }, { id: 'sig-2' }],
    ...overrides,
  }
}

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/onchain/multisig-broadcasts', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockActor as any)
  vi.mocked(prisma.walletSigner.findUnique).mockResolvedValue({ id: 'signer-row-1' } as any)
  vi.mocked(prisma.multisigProposal.findUnique).mockResolvedValue(makeProposal() as any)
  vi.mocked(prisma.multisigProposal.updateMany).mockResolvedValue({ count: 1 } as any)
  vi.mocked(prisma.multisigProposal.update).mockResolvedValue({
    id: 'proposal-1',
    status: 'executed',
    stellarTxHash: 'tx-hash-final',
    executedAt: new Date(),
  } as any)
  vi.mocked(submitMultisigPaymentWithRetry).mockResolvedValue({ status: 'confirmed', hash: 'tx-hash-final' })
})

describe('POST /api/onchain/multisig-broadcasts', () => {
  it('broadcasts a fully-signed proposal and persists the resulting hash', async () => {
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.stellarTxHash).toBe('tx-hash-final')
    expect(prisma.multisigProposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proposal-1' },
        data: expect.objectContaining({ status: 'executed', stellarTxHash: 'tx-hash-final' }),
      }),
    )
  })

  it('claims execution before broadcasting so concurrent calls cannot double-submit', async () => {
    await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(prisma.multisigProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proposal-1', status: 'pending' },
        data: expect.objectContaining({ status: 'executing' }),
      }),
    )
  })

  it('returns 409 when the proposal is already being broadcast by another request', async () => {
    vi.mocked(prisma.multisigProposal.updateMany).mockResolvedValue({ count: 0 } as any)
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(409)
    expect(submitMultisigPaymentWithRetry).not.toHaveBeenCalled()
  })

  it('does not persist stellarTxHash when the broadcast fails, and releases the claim', async () => {
    vi.mocked(submitMultisigPaymentWithRetry).mockRejectedValue(new Error('tx_bad_seq retries exhausted'))
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(502)
    expect(prisma.multisigProposal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proposal-1' },
        data: expect.objectContaining({ status: 'pending', lastError: expect.any(String) }),
      }),
    )
    expect(prisma.multisigProposal.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stellarTxHash: expect.anything() }) }),
    )
  })

  it('returns 200 idempotently when the proposal was already executed', async () => {
    vi.mocked(prisma.multisigProposal.findUnique).mockResolvedValue(
      makeProposal({ status: 'executed', stellarTxHash: 'already-broadcast' }) as any,
    )
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.stellarTxHash).toBe('already-broadcast')
    expect(submitMultisigPaymentWithRetry).not.toHaveBeenCalled()
  })

  it('returns 400 when the proposal does not have enough signatures', async () => {
    vi.mocked(prisma.multisigProposal.findUnique).mockResolvedValue(
      makeProposal({ signatures: [{ id: 'sig-1' }] }) as any,
    )
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when the proposal has expired', async () => {
    vi.mocked(prisma.multisigProposal.findUnique).mockResolvedValue(
      makeProposal({ expiresAt: new Date(Date.now() - 1000) }) as any,
    )
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when the proposal status is not broadcastable', async () => {
    vi.mocked(prisma.multisigProposal.findUnique).mockResolvedValue(
      makeProposal({ status: 'rejected' }) as any,
    )
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(400)
  })

  it('returns 403 when the requester is not a signer on the wallet', async () => {
    vi.mocked(prisma.walletSigner.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(403)
  })

  it('returns 404 when the proposal does not exist', async () => {
    vi.mocked(prisma.multisigProposal.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest({ proposalId: 'missing' }))
    expect(res.status).toBe(404)
  })

  it('returns 400 when proposalId is missing', async () => {
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(new NextRequest('http://localhost/api/onchain/multisig-broadcasts', { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when the acting user record is missing', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(404)
  })

  it('returns 500 when an unexpected error occurs', async () => {
    vi.mocked(prisma.multisigProposal.findUnique).mockRejectedValue(new Error('db down'))
    const res = await POST(makeRequest({ proposalId: 'proposal-1' }))
    expect(res.status).toBe(500)
  })
})
