import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    multisigProposal: { findFirst: vi.fn(), updateMany: vi.fn() },
    proposalSignature: { deleteMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { POST } from './route'

const context = { params: Promise.resolve({ id: 'wallet-1', proposalId: 'proposal-1' }) }

function makeRequest(headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/proposals/proposal-1/cancel', {
    method: 'POST',
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'a@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1',
    stellarAddress: 'G'.padEnd(56, 'A'),
    threshold: 2,
    signers: [{ id: 'wallet-signer-1' }],
  } as any)
  vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
    id: 'proposal-1',
    proposerId: 'user-1',
    status: 'pending',
  } as any)
  vi.mocked(prisma.multisigProposal.updateMany).mockResolvedValue({ count: 1 } as any)
})

describe('POST cancel proposal', () => {
  it('lets the proposer cancel and keeps existing signatures', async () => {
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ proposalId: 'proposal-1', status: 'cancelled' })
    expect(prisma.multisigProposal.updateMany).toHaveBeenCalledWith({
      where: { id: 'proposal-1', status: { notIn: ['executing', 'executed', 'cancelled'] } },
      data: { status: 'cancelled', lastError: null },
    })
    expect(prisma.proposalSignature.deleteMany).not.toHaveBeenCalled()
  })

  it('returns 403 when a signer other than the proposer tries to cancel', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
      id: 'proposal-1', proposerId: 'user-2', status: 'pending',
    } as any)
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('NOT_PROPOSER')
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
  })

  it('returns 403 to a user who is not a wallet signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1', stellarAddress: 'G'.padEnd(56, 'A'), threshold: 2, signers: [],
    } as any)
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(403)
    expect(prisma.multisigProposal.findFirst).not.toHaveBeenCalled()
  })

  it.each(['executing', 'executed', 'cancelled'])('returns 409 when status is %s', async (status) => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue({
      id: 'proposal-1', proposerId: 'user-1', status,
    } as any)
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(409)
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
  })

  it('returns 409 when execution starts between the read and the write', async () => {
    vi.mocked(prisma.multisigProposal.updateMany).mockResolvedValue({ count: 0 } as any)
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(409)
  })

  it('returns 404 for a proposal outside the wallet', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockResolvedValue(null)
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(404)
  })

  it('returns 401 without a bearer token', async () => {
    const response = await POST(makeRequest({}), context)
    expect(response.status).toBe(401)
  })

  it('returns 500 when the database fails', async () => {
    vi.mocked(prisma.multisigProposal.findFirst).mockRejectedValue(new Error('db down'))
    const response = await POST(makeRequest(), context)
    expect(response.status).toBe(500)
  })
})
