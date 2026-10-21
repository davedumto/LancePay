import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Keypair } from '@stellar/stellar-sdk'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn(), update: vi.fn() },
    walletSigner: { findMany: vi.fn() },
    multisigProposal: { updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { PATCH } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const WALLET_ADDRESS = Keypair.random().publicKey()
const ctx = () => ({ params: Promise.resolve({ id: 'wallet-1' }) })

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/collective-wallets/wallet-1/threshold', {
    method: 'PATCH',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'signer1@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1',
    stellarAddress: WALLET_ADDRESS,
    threshold: 2,
    signers: [{ id: 'ws-1' }],
  } as any)
  vi.mocked(prisma.walletSigner.findMany).mockResolvedValue([
    { id: 'ws-1', userId: 'user-1', weight: 1 },
    { id: 'ws-2', userId: 'user-2', weight: 1 },
    { id: 'ws-3', userId: 'user-3', weight: 2 },
  ] as any)
  vi.mocked(prisma.collectiveWallet.update).mockImplementation(async ({ data }: any) => ({
    id: 'wallet-1',
    name: 'Team Wallet',
    stellarAddress: WALLET_ADDRESS,
    threshold: data.threshold,
    createdAt: new Date('2026-01-01'),
  }))
})

describe('PATCH /api/collective-wallets/[id]/threshold', () => {
  it('updates threshold when signed off by a majority of existing signers', async () => {
    // 3 signers, majority required is 2. Caller (user-1) + user-2 approved = 2 approvals.
    const res = await PATCH(makeRequest({ threshold: 3, approvals: ['user-2'] }), ctx())
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.threshold).toBe(3)
    expect(data.previousThreshold).toBe(2)
    expect(prisma.collectiveWallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { threshold: 3 },
      select: expect.any(Object),
    })
    // Proposals table is not modified, leaving in-flight proposals unaffected
    expect(prisma.multisigProposal.updateMany).not.toHaveBeenCalled()
  })

  it('rejects threshold greater than sum of current signer weights', async () => {
    // Total weight = 1 + 1 + 2 = 4. Requested = 5.
    const res = await PATCH(makeRequest({ threshold: 5, approvals: ['user-2', 'user-3'] }), ctx())
    expect(res.status).toBe(400)

    const data = await res.json()
    expect(data.code).toBe('THRESHOLD_EXCEEDS_SIGNER_WEIGHTS')
    expect(prisma.collectiveWallet.update).not.toHaveBeenCalled()
  })

  it('rejects threshold less than 1 or non-integer', async () => {
    const resZero = await PATCH(makeRequest({ threshold: 0 }), ctx())
    expect(resZero.status).toBe(400)

    const resNegative = await PATCH(makeRequest({ threshold: -2 }), ctx())
    expect(resNegative.status).toBe(400)

    const resFloat = await PATCH(makeRequest({ threshold: 2.5 }), ctx())
    expect(resFloat.status).toBe(400)
  })

  it('rejects update without majority sign-off (requester alone on a 3-signer wallet)', async () => {
    // 3 signers, only user-1 signed off without approvals from others
    const res = await PATCH(makeRequest({ threshold: 3 }), ctx())
    expect(res.status).toBe(403)

    const data = await res.json()
    expect(data.code).toBe('MAJORITY_APPROVAL_REQUIRED')
    expect(data.details.approvedCount).toBe(1)
    expect(data.details.requiredMajority).toBe(2)
    expect(prisma.collectiveWallet.update).not.toHaveBeenCalled()
  })

  it('ignores invalid approvers who are not signers on the wallet', async () => {
    // 'random-user' is not a signer
    const res = await PATCH(makeRequest({ threshold: 2, approvals: ['random-user'] }), ctx())
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.code).toBe('MAJORITY_APPROVAL_REQUIRED')
    expect(data.details.approvedCount).toBe(1)
  })

  it('accepts WalletSigner IDs in approvals list', async () => {
    // 'ws-2' is the WalletSigner id for user-2
    const res = await PATCH(makeRequest({ threshold: 2, approvals: ['ws-2'] }), ctx())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.threshold).toBe(2)
  })

  it('returns 403 when caller is not a wallet signer', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1',
      stellarAddress: WALLET_ADDRESS,
      threshold: 2,
      signers: [],
    } as any)

    const res = await PATCH(makeRequest({ threshold: 2, approvals: ['user-2'] }), ctx())
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.code).toBe('NOT_A_SIGNER')
  })

  it('returns 404 when wallet does not exist', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(null)

    const res = await PATCH(makeRequest({ threshold: 2 }), ctx())
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.code).toBe('WALLET_NOT_FOUND')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)

    const res = await PATCH(makeRequest({ threshold: 2 }), ctx())
    expect(res.status).toBe(401)
  })
})
