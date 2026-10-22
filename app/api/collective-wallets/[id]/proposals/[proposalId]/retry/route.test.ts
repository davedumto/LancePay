import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Keypair } from '@stellar/stellar-sdk'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    multisigProposal: { findFirst: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/crypto', () => ({ decrypt: vi.fn(() => 'SSECRETKEY') }))
vi.mock('@/lib/stellar', () => ({ submitMultisigPaymentWithRetry: vi.fn() }))

import { POST, MAX_RETRY_ATTEMPTS } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { submitMultisigPaymentWithRetry } from '@/lib/stellar'

const WALLET_ADDRESS = Keypair.random().publicKey()
const DEST_ADDRESS = Keypair.random().publicKey()
const NOW = new Date('2026-10-18T12:00:00Z')
const ctx = (id = 'wallet-1', proposalId = 'prop-1') => ({
  params: Promise.resolve({ id, proposalId }),
})

function makeRequest(id = 'wallet-1', proposalId = 'prop-1'): NextRequest {
  return new NextRequest(
    `http://localhost/api/collective-wallets/${id}/proposals/${proposalId}/retry`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    }
  )
}

const BASE_FAILED_PROPOSAL = {
  id: 'prop-1',
  walletId: 'wallet-1',
  proposerId: 'user-1',
  destinationAddress: DEST_ADDRESS,
  amountUsdc: '100.000000',
  memo: 'test retry',
  status: 'pending',
  lastError: 'tx_bad_seq: network sequence mismatch',
  stellarTxHash: null,
  expiresAt: new Date('2026-10-25T12:00:00Z'),
  executionStartedAt: new Date('2026-10-18T10:00:00Z'),
  executedAt: null,
  signatures: [{ id: 'sig-1' }, { id: 'sig-2' }],
  wallet: {
    id: 'wallet-1',
    stellarAddress: WALLET_ADDRESS,
    threshold: 2,
    encryptedSecretKey: 'enc_secret',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'alice@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1',
    stellarAddress: WALLET_ADDRESS,
    threshold: 2,
    signers: [{ id: 'ws-1' }],
  } as any)
  vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({ ...BASE_FAILED_PROPOSAL } as any)
  vi.mocked(submitMultisigPaymentWithRetry).mockResolvedValue('tx-hash-success')
  vi.mocked(prisma.multisigProposal.update).mockImplementation(async ({ data }: any) => ({
    ...BASE_FAILED_PROPOSAL,
    ...data,
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/collective-wallets/[id]/proposals/[proposalId]/retry', () => {
  it('successfully retries a failed proposal execution on happy path', async () => {
    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.stellarTxHash).toBe('tx-hash-success')
    expect(data.status).toBe('executed')

    // 1st update: Optimistic clearing of lastError + setting executing status while keeping executionStartedAt
    expect(prisma.multisigProposal.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: 'prop-1' },
        data: expect.objectContaining({
          status: 'executing',
          lastError: null,
          executionStartedAt: BASE_FAILED_PROPOSAL.executionStartedAt,
        }),
      })
    )

    // 2nd update: Setting executed status
    expect(prisma.multisigProposal.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'prop-1' },
        data: expect.objectContaining({
          status: 'executed',
          stellarTxHash: 'tx-hash-success',
          lastError: null,
          executionStartedAt: BASE_FAILED_PROPOSAL.executionStartedAt,
        }),
      })
    )
  })

  it('rejects retry if proposal already has stellarTxHash', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
      ...BASE_FAILED_PROPOSAL,
      stellarTxHash: 'already-broadcast-hash',
    } as any)

    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.code).toBe('ALREADY_EXECUTED')
    expect(submitMultisigPaymentWithRetry).not.toHaveBeenCalled()
  })

  it('rejects retry if lastError is not populated', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
      ...BASE_FAILED_PROPOSAL,
      lastError: null,
    } as any)

    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.code).toBe('NOT_FAILED')
    expect(submitMultisigPaymentWithRetry).not.toHaveBeenCalled()
  })

  it('rejects retry if signatures have not reached threshold', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
      ...BASE_FAILED_PROPOSAL,
      signatures: [{ id: 'sig-1' }], // threshold is 2
    } as any)

    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.code).toBe('THRESHOLD_NOT_MET')
    expect(submitMultisigPaymentWithRetry).not.toHaveBeenCalled()
  })

  it('rejects retry if proposal has expired', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
      ...BASE_FAILED_PROPOSAL,
      expiresAt: new Date('2026-10-10T00:00:00Z'), // in the past
    } as any)

    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.code).toBe('PROPOSAL_EXPIRED')
    expect(submitMultisigPaymentWithRetry).not.toHaveBeenCalled()
  })

  it('caps retry attempts and sets permanent-failure state once exceeded', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
      ...BASE_FAILED_PROPOSAL,
      lastError: `[attempt ${MAX_RETRY_ATTEMPTS}] repeated network error`,
    } as any)

    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(400)

    const data = await res.json()
    expect(data.code).toBe('PERMANENT_FAILURE')
    expect(data.status).toBe('permanently_failed')

    expect(prisma.multisigProposal.update).toHaveBeenCalledWith({
      where: { id: 'prop-1' },
      data: { status: 'permanently_failed' },
    })
    expect(submitMultisigPaymentWithRetry).not.toHaveBeenCalled()
  })

  it('restores lastError and keeps executionStartedAt consistent when retry fails', async () => {
    vi.mocked(submitMultisigPaymentWithRetry).mockRejectedValue(new Error('Network timeout'))

    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(502)

    const data = await res.json()
    expect(data.code).toBe('RETRY_FAILED')
    expect(data.error).toBe('Network timeout')

    // First call optimistically cleared lastError
    expect(prisma.multisigProposal.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: null,
          executionStartedAt: BASE_FAILED_PROPOSAL.executionStartedAt,
        }),
      })
    )

    // Second call restored lastError with attempt info and kept executionStartedAt
    expect(prisma.multisigProposal.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: expect.stringContaining('Network timeout'),
          executionStartedAt: BASE_FAILED_PROPOSAL.executionStartedAt,
        }),
      })
    )
  })

  it('returns 403 when caller is not a wallet signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1',
      stellarAddress: WALLET_ADDRESS,
      threshold: 2,
      signers: [],
    } as any)

    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.code).toBe('NOT_A_SIGNER')
  })

  it('returns 404 when proposal not found', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(null)

    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.code).toBe('PROPOSAL_NOT_FOUND')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)

    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(401)
  })
})
