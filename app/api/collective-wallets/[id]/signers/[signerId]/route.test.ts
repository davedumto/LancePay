import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'

vi.mock('@/lib/db', () => {
  const prisma: any = {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    walletSigner: { findFirst: vi.fn(), aggregate: vi.fn(), delete: vi.fn() },
    multisigProposal: { findMany: vi.fn() },
  }
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma))
  return { prisma }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { DELETE } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ctx = (signerId = 'ws-2') => ({ params: Promise.resolve({ id: 'wallet-1', signerId }) })

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/signers/ws-2', {
    method: 'DELETE',
    headers: { authorization: 'Bearer token' },
  })
}

function mockTotals(weight: number, count: number) {
  vi.mocked(prisma.walletSigner.aggregate).mockResolvedValue({
    _sum: { weight },
    _count: { _all: count },
  } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'a@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1',
    stellarAddress: 'GADDR',
    threshold: 2,
    signers: [{ id: 'ws-1' }],
  } as any)
  vi.mocked(prisma.walletSigner.findFirst).mockResolvedValue({ id: 'ws-2', userId: 'user-2', weight: 1 } as any)
  mockTotals(3, 3)
  vi.mocked(prisma.multisigProposal.findMany).mockResolvedValue([])
  vi.mocked(prisma.walletSigner.delete).mockResolvedValue({} as any)
})

describe('DELETE /api/collective-wallets/[id]/signers/[signerId]', () => {
  it('removes a signer when quorum is preserved', async () => {
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({
      removed: { id: 'ws-2', userId: 'user-2' },
      remainingWeight: 2,
      remainingSigners: 2,
      threshold: 2,
    })
    expect(prisma.walletSigner.delete).toHaveBeenCalledWith({ where: { id: 'ws-2' } })
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    })
  })

  it('scopes the signer lookup to the wallet', async () => {
    await DELETE(makeRequest(), ctx())
    expect(prisma.walletSigner.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ws-2', walletId: 'wallet-1' } })
    )
  })

  it('rejects when remaining weight would fall below the threshold', async () => {
    vi.mocked(prisma.walletSigner.findFirst).mockResolvedValue({ id: 'ws-2', userId: 'user-2', weight: 3 } as any)
    mockTotals(4, 3)
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('QUORUM_VIOLATION')
    expect(data.details).toEqual({ remainingWeight: 1, remainingSigners: 2, threshold: 2 })
    expect(prisma.walletSigner.delete).not.toHaveBeenCalled()
  })

  it('rejects when too few signers would remain even if weight suffices', async () => {
    mockTotals(5, 2) // one heavy signer would remain alone with threshold 2
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('QUORUM_VIOLATION')
    expect(prisma.walletSigner.delete).not.toHaveBeenCalled()
  })

  it('rejects when the signer has pending proposals', async () => {
    vi.mocked(prisma.multisigProposal.findMany).mockResolvedValue([{ id: 'prop-1' }] as any)
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe('PENDING_PROPOSALS')
    expect(data.details.proposalIds).toEqual(['prop-1'])
    expect(prisma.walletSigner.delete).not.toHaveBeenCalled()

    const where = vi.mocked(prisma.multisigProposal.findMany).mock.calls[0][0]!.where as any
    expect(where).toMatchObject({ walletId: 'wallet-1', proposerId: 'user-2', status: 'pending' })
    expect(where.expiresAt.gt).toBeInstanceOf(Date)
  })

  it('returns 404 SIGNER_NOT_FOUND when the signer is not on the wallet', async () => {
    vi.mocked(prisma.walletSigner.findFirst).mockResolvedValue(null)
    const res = await DELETE(makeRequest(), ctx('ws-missing'))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('SIGNER_NOT_FOUND')
  })

  it('returns 404 WALLET_NOT_FOUND when the wallet does not exist', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(null)
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('WALLET_NOT_FOUND')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('returns 403 when the caller is not a signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1',
      stellarAddress: 'GADDR',
      threshold: 2,
      signers: [],
    } as any)
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(403)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('returns a retryable 409 on serialization failure', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('serialization failure', {
        code: 'P2034',
        clientVersion: 'test',
      })
    )
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('CONFLICT')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected errors', async () => {
    vi.mocked(prisma.walletSigner.delete).mockRejectedValue(new Error('db down'))
    const res = await DELETE(makeRequest(), ctx())
    expect(res.status).toBe(500)
  })
})
