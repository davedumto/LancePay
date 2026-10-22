import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Keypair } from '@stellar/stellar-sdk'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    collectiveWallet: { findUnique: vi.fn() },
    multisigProposal: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const WALLET_ADDRESS = Keypair.random().publicKey()
const NOW = new Date('2026-10-18T12:00:00Z')
const ctx = () => ({ params: Promise.resolve({ id: 'wallet-1' }) })

function makeRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/collective-wallets/wallet-1/audit-log${query}`, {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email: 'signer@example.com' } as any)
  vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
    id: 'wallet-1',
    stellarAddress: WALLET_ADDRESS,
    threshold: 2,
    signers: [{ id: 'ws-1' }],
  } as any)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/collective-wallets/[id]/audit-log', () => {
  it('merges proposal lifecycle events (created, signed, executed, expired, cancelled) into a chronological feed', async () => {
    const mockProposals = [
      {
        id: 'prop-1',
        walletId: 'wallet-1',
        proposerId: 'user-1',
        destinationAddress: 'GDEST1',
        amountUsdc: '100.000000',
        memo: 'Payment 1',
        status: 'executed',
        createdAt: new Date('2026-10-10T10:00:00Z'),
        executedAt: new Date('2026-10-11T12:00:00Z'),
        stellarTxHash: 'tx-hash-1',
        expiresAt: new Date('2026-10-13T10:00:00Z'),
        proposer: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
        signatures: [
          {
            id: 'sig-1',
            signerId: 'user-1',
            createdAt: new Date('2026-10-10T10:05:00Z'),
            signer: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
          },
          {
            id: 'sig-2',
            signerId: 'user-2',
            createdAt: new Date('2026-10-11T11:00:00Z'),
            signer: { id: 'user-2', name: 'Bob', email: 'bob@example.com' },
          },
        ],
      },
      {
        id: 'prop-2',
        walletId: 'wallet-1',
        proposerId: 'user-2',
        destinationAddress: 'GDEST2',
        amountUsdc: '50.000000',
        memo: 'Payment 2',
        status: 'pending',
        createdAt: new Date('2026-10-12T10:00:00Z'),
        executedAt: null,
        stellarTxHash: null,
        expiresAt: new Date('2026-10-14T10:00:00Z'), // Past NOW, so expired!
        proposer: { id: 'user-2', name: 'Bob', email: 'bob@example.com' },
        signatures: [],
      },
      {
        id: 'prop-3',
        walletId: 'wallet-1',
        proposerId: 'user-1',
        destinationAddress: 'GDEST3',
        amountUsdc: '25.000000',
        memo: 'Payment 3',
        status: 'cancelled',
        createdAt: new Date('2026-10-15T10:00:00Z'),
        executedAt: null,
        stellarTxHash: null,
        expiresAt: new Date('2026-10-20T10:00:00Z'),
        proposer: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
        signatures: [],
      },
    ]

    vi.mocked(prisma.multisigProposal.findMany).mockResolvedValue(mockProposals as any)

    const res = await GET(makeRequest(), ctx())
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.events).toBeDefined()
    expect(data.total).toBe(8)

    // Events in chronological order:
    // 1. prop-1 created: 2026-10-10 10:00
    // 2. prop-1 signed (sig-1): 2026-10-10 10:05
    // 3. prop-1 signed (sig-2): 2026-10-11 11:00
    // 4. prop-1 executed: 2026-10-11 12:00
    // 5. prop-2 created: 2026-10-12 10:00
    // 6. prop-2 expired: 2026-10-14 10:00
    // 7. prop-3 created: 2026-10-15 10:00
    // (and prop-3 cancelled)

    const eventTypes = data.events.map((e: any) => e.eventType)
    expect(eventTypes).toContain('created')
    expect(eventTypes).toContain('signed')
    expect(eventTypes).toContain('executed')
    expect(eventTypes).toContain('expired')
    expect(eventTypes).toContain('cancelled')

    // Check chronological order (strictly ascending timestamps)
    for (let i = 0; i < data.events.length - 1; i++) {
      const t1 = new Date(data.events[i].timestamp).getTime()
      const t2 = new Date(data.events[i + 1].timestamp).getTime()
      expect(t1).toBeLessThanOrEqual(t2)
    }
  })

  it('supports cursor-based pagination with limit', async () => {
    const mockProposals = [
      {
        id: 'prop-1',
        walletId: 'wallet-1',
        proposerId: 'user-1',
        destinationAddress: 'GDEST1',
        amountUsdc: '100',
        memo: null,
        status: 'pending',
        createdAt: new Date('2026-10-10T10:00:00Z'),
        executedAt: null,
        stellarTxHash: null,
        expiresAt: new Date('2026-10-25T10:00:00Z'),
        proposer: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
        signatures: [
          {
            id: 'sig-1',
            signerId: 'user-1',
            createdAt: new Date('2026-10-10T10:05:00Z'),
            signer: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
          },
        ],
      },
      {
        id: 'prop-2',
        walletId: 'wallet-1',
        proposerId: 'user-2',
        destinationAddress: 'GDEST2',
        amountUsdc: '200',
        memo: null,
        status: 'pending',
        createdAt: new Date('2026-10-11T10:00:00Z'),
        executedAt: null,
        stellarTxHash: null,
        expiresAt: new Date('2026-10-25T10:00:00Z'),
        proposer: { id: 'user-2', name: 'Bob', email: 'bob@example.com' },
        signatures: [],
      },
    ]

    vi.mocked(prisma.multisigProposal.findMany).mockResolvedValue(mockProposals as any)

    // Request limit=2 (first page)
    const res1 = await GET(makeRequest('?limit=2'), ctx())
    expect(res1.status).toBe(200)
    const page1 = await res1.json()
    expect(page1.events).toHaveLength(2)
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).toBe(page1.events[1].id)

    // Request second page with cursor
    const res2 = await GET(makeRequest(`?limit=2&cursor=${page1.nextCursor}`), ctx())
    expect(res2.status).toBe(200)
    const page2 = await res2.json()
    expect(page2.events).toHaveLength(1)
    expect(page2.hasMore).toBe(false)
    expect(page2.nextCursor).toBeNull()
  })

  it('restricts visibility to wallet signers only (403 for non-signers)', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue({
      id: 'wallet-1',
      stellarAddress: WALLET_ADDRESS,
      threshold: 2,
      signers: [],
    } as any)

    const res = await GET(makeRequest(), ctx())
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.code).toBe('NOT_A_SIGNER')
  })

  it('returns 404 when wallet does not exist', async () => {
    vi.mocked(prisma.collectiveWallet.findUnique).mockResolvedValue(null)

    const res = await GET(makeRequest(), ctx())
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.code).toBe('WALLET_NOT_FOUND')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)

    const res = await GET(makeRequest(), ctx())
    expect(res.status).toBe(401)
  })
})
