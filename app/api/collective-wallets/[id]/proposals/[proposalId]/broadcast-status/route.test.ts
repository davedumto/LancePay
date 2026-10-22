import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    multisigProposal: { findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { GET } from './route'

const context = { params: Promise.resolve({ id: 'wallet-1', proposalId: 'proposal-1' }) }
const broadcast = {
  id: 'broadcast-1',
  txHash: 'tx-1',
  network: 'stellar',
  status: 'pending',
  broadcastAt: new Date('2026-10-18T12:00:00Z'),
  confirmedAt: null,
  failureReason: null,
}

function makeRequest() {
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/proposals/proposal-1/broadcast-status', {
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'a@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1', stellarAddress: 'G'.padEnd(56, 'A'), threshold: 2, signers: [{ id: 'signer-1' }],
  } as any)
  vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
    id: 'proposal-1', status: 'executed', broadcast,
  } as any)
})

describe('GET proposal broadcast status', () => {
  it('reports a pending broadcast', async () => {
    const response = await GET(makeRequest(), context)
    expect(response.status).toBe(200)
    expect((await response.json()).status).toBe('pending')
  })

  it('derives confirmed state from confirmedAt', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
      id: 'proposal-1',
      status: 'executed',
      broadcast: { ...broadcast, status: 'pending', confirmedAt: new Date('2026-10-18T12:01:00Z') },
    } as any)
    const response = await GET(makeRequest(), context)
    expect((await response.json()).status).toBe('confirmed')
  })

  it('surfaces failureReason for a failed broadcast', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
      id: 'proposal-1',
      status: 'executed',
      broadcast: { ...broadcast, status: 'failed', failureReason: 'Transaction rejected' },
    } as any)
    const response = await GET(makeRequest(), context)
    expect(await response.json()).toMatchObject({ status: 'failed', failureReason: 'Transaction rejected' })
  })

  it('restricts status to wallet signers', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1', stellarAddress: 'G'.padEnd(56, 'A'), threshold: 2, signers: [],
    } as any)
    const response = await GET(makeRequest(), context)
    expect(response.status).toBe(403)
    expect(prisma.multisigProposal.findFirst).not.toHaveBeenCalled()
  })

  it('returns 404 when no broadcast exists', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
      id: 'proposal-1', status: 'executed', broadcast: null,
    } as any)
    const response = await GET(makeRequest(), context)
    expect(response.status).toBe(404)
  })
})