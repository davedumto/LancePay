import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { EXECUTION_STALL_TIMEOUT_MS, GET } from './route'

const NOW = new Date('2026-01-01T12:00:00Z')
const context = { params: Promise.resolve({ id: 'wallet-1', proposalId: 'proposal-1' }) }

function makeRequest() {
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/proposals/proposal-1/status', {
    headers: { authorization: 'Bearer token' },
  })
}

function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proposal-1',
    status: 'pending',
    expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    executionStartedAt: null,
    executedAt: null,
    stellarTxHash: null,
    lastError: null,
    signatures: [{ signerId: 'user-1' }],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'a@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1',
    stellarAddress: 'G'.padEnd(56, 'A'),
    threshold: 3,
    signers: [{ id: 'wallet-signer-1' }],
  } as any)
  vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(makeProposal() as any)
  vi.mocked(prisma.walletSigner.findMany).mockResolvedValue([{ userId: 'user-1', weight: 1 }] as any)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET proposal status', () => {
  it('reports signatures collected against the threshold weight', async () => {
    const response = await GET(makeRequest(), context)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      proposalId: 'proposal-1',
      status: 'pending',
      signaturesCollected: 1,
      currentWeight: 1,
      requiredThreshold: 3,
      thresholdMet: false,
      expired: false,
      stellarTxHash: null,
      lastError: null,
      stalled: false,
    })
  })

  it('includes stellarTxHash once executed', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(makeProposal({
      status: 'executed',
      executionStartedAt: new Date(NOW.getTime() - 60_000),
      executedAt: new Date(NOW.getTime() - 30_000),
      stellarTxHash: 'tx-hash-1',
      signatures: [{ signerId: 'user-1' }, { signerId: 'user-2' }],
    }) as any)
    vi.mocked(prisma.walletSigner.findMany).mockResolvedValue([
      { userId: 'user-1', weight: 1 },
      { userId: 'user-2', weight: 2 },
    ] as any)
    const body = await (await GET(makeRequest(), context)).json()
    expect(body).toMatchObject({ status: 'executed', stellarTxHash: 'tx-hash-1', currentWeight: 3, thresholdMet: true, stalled: false })
  })

  it('surfaces lastError after a failed execution', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(
      makeProposal({ lastError: 'tx_bad_seq' }) as any
    )
    const body = await (await GET(makeRequest(), context)).json()
    expect(body.lastError).toBe('tx_bad_seq')
  })

  it('flags an execution stuck past the timeout as stalled', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(makeProposal({
      status: 'executing',
      executionStartedAt: new Date(NOW.getTime() - EXECUTION_STALL_TIMEOUT_MS - 1),
    }) as any)
    const body = await (await GET(makeRequest(), context)).json()
    expect(body.stalled).toBe(true)
  })

  it('does not flag an execution still within the timeout', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(makeProposal({
      status: 'executing',
      executionStartedAt: new Date(NOW.getTime() - EXECUTION_STALL_TIMEOUT_MS + 1000),
    }) as any)
    const body = await (await GET(makeRequest(), context)).json()
    expect(body.stalled).toBe(false)
  })

  it('skips the weight lookup when there are no signatures', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(makeProposal({ signatures: [] }) as any)
    const body = await (await GET(makeRequest(), context)).json()
    expect(body.currentWeight).toBe(0)
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
})
