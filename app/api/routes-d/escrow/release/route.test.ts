/**
 * Tests for escrow release waterfall distribution fix.
 *
 * These tests verify that:
 *  1. Invoices WITHOUT collaborators still send 100% to the freelancer
 *  2. Invoices WITH collaborators correctly split funds via waterfall
 *  3. Pre-flight validation rejects missing wallets before any state changes
 */
import { NextRequest } from 'next/server'
import { POST } from './route'

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockSendStellarPayment = jest.fn().mockResolvedValue({ hash: 'mock-tx-hash' })
jest.mock('@/lib/stellar', () => ({
  sendStellarPayment: (...args: any[]) => mockSendStellarPayment(...args),
}))

const mockReleaseEscrowFunds = jest.fn().mockResolvedValue(undefined)
jest.mock('@/app/api/routes-d/escrow/_shared', () => ({
  EscrowReleaseSchema: require('zod').z.object({
    invoiceId: require('zod').z.string(),
    clientEmail: require('zod').z.string().email(),
    approvalNotes: require('zod').z.string().optional(),
  }),
  getAuthContext: jest.fn().mockResolvedValue({ email: 'client@example.com' }),
  releaseEscrowFunds: (...args: any[]) => mockReleaseEscrowFunds(...args),
}))

jest.mock('@/lib/email', () => ({
  sendEscrowReleasedEmail: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn() },
}))

// Prisma mock — we control what findUnique returns per test
const mockFindUnique = jest.fn()
const mockUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
const mockCreate = jest.fn().mockResolvedValue({})
const mockTransaction = jest.fn()

jest.mock('@/lib/db', () => ({
  prisma: {
    invoice: {
      findUnique: (...args: any[]) => mockFindUnique(...args),
    },
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
}))

// Helper: create a minimal NextRequest with JSON body
function makeRequest(body: object): NextRequest {
  return new NextRequest('http://localhost/api/escrow/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── Shared invoice factories ─────────────────────────────────────────────────

function baseInvoice(overrides: object = {}) {
  return {
    id: 'inv-1',
    invoiceNumber: 'INV-001',
    clientEmail: 'client@example.com',
    escrowEnabled: true,
    escrowStatus: 'held',
    escrowAmountUsdc: 1000,
    escrowContractId: null,
    user: {
      id: 'user-1',
      email: 'freelancer@example.com',
      name: 'Alice',
      walletAddress: 'GFREELANCER000000000000000000000000000000000000000000000',
    },
    collaborators: [],
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()

  // Default $transaction implementation: run the callback and intercept the
  // inner findUnique so it returns a resolved invoice stub.
  mockTransaction.mockImplementation(async (cb: any) => {
    const txStub = {
      invoice: {
        updateMany: mockUpdateMany,
        findUnique: jest.fn().mockResolvedValue({
          id: 'inv-1',
          escrowStatus: 'released',
          escrowReleasedAt: new Date(),
        }),
      },
      escrowEvent: { create: mockCreate },
    }
    return cb(txStub)
  })
})

describe('POST /api/escrow/release', () => {
  // ── Test 1: No collaborators → 100% to freelancer ──────────────────────────
  it('sends full escrow amount to freelancer when no collaborators exist', async () => {
    mockFindUnique.mockResolvedValue(baseInvoice())

    const req = makeRequest({
      invoiceId: 'inv-1',
      clientEmail: 'client@example.com',
    })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)

    // Only ONE Stellar payment should fire — the full amount to the freelancer
    expect(mockSendStellarPayment).toHaveBeenCalledTimes(1)
    expect(mockSendStellarPayment).toHaveBeenCalledWith(
      'GFREELANCER000000000000000000000000000000000000000000000',
      '1000',
      'USDC'
    )

    expect(json.distribution.freelancerAmountUsdc).toBe(1000)
    expect(json.distribution.collaboratorPayments).toHaveLength(0)
  })

  // ── Test 2: 30% collaborator split → $300 to collaborator, $700 to freelancer
  it('correctly waterfalls 30% to collaborator and 70% to freelancer', async () => {
    mockFindUnique.mockResolvedValue(
      baseInvoice({
        collaborators: [
          {
            id: 'collab-1',
            email: 'bob@example.com',
            walletAddress: 'GCOLLABORATOR0000000000000000000000000000000000000000000',
            revenueSharePercent: 30,
          },
        ],
      })
    )

    const req = makeRequest({
      invoiceId: 'inv-1',
      clientEmail: 'client@example.com',
    })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)

    // TWO Stellar payments: collaborator first, then freelancer remainder
    expect(mockSendStellarPayment).toHaveBeenCalledTimes(2)

    // Collaborator receives exactly 30% = $300
    expect(mockSendStellarPayment).toHaveBeenNthCalledWith(
      1,
      'GCOLLABORATOR0000000000000000000000000000000000000000000',
      '300',
      'USDC'
    )

    // Freelancer receives the remainder = $700
    expect(mockSendStellarPayment).toHaveBeenNthCalledWith(
      2,
      'GFREELANCER000000000000000000000000000000000000000000000',
      '700',
      'USDC'
    )

    expect(json.distribution.freelancerAmountUsdc).toBe(700)
    expect(json.distribution.collaboratorPayments[0].amountUsdc).toBe(300)
    expect(json.distribution.collaboratorPayments[0].revenueSharePercent).toBe(30)
  })

  // ── Test 3: Collaborator missing wallet → 422 before any state change ───────
  it('returns 422 and does not release escrow if a collaborator has no wallet', async () => {
    mockFindUnique.mockResolvedValue(
      baseInvoice({
        collaborators: [
          {
            id: 'collab-2',
            email: 'charlie@example.com',
            walletAddress: null, // ← missing wallet
            revenueSharePercent: 20,
          },
        ],
      })
    )

    const req = makeRequest({
      invoiceId: 'inv-1',
      clientEmail: 'client@example.com',
    })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error).toMatch(/wallet address/i)

    // No DB writes or Stellar payments should have occurred
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockSendStellarPayment).not.toHaveBeenCalled()
  })

  // ── Test 4: Combined shares ≥ 100% → 422 before any state change ────────────
  it('returns 422 when combined collaborator shares meet or exceed 100%', async () => {
    mockFindUnique.mockResolvedValue(
      baseInvoice({
        collaborators: [
          {
            id: 'collab-3',
            email: 'd@example.com',
            walletAddress: 'GCOLLABORATOR_D',
            revenueSharePercent: 60,
          },
          {
            id: 'collab-4',
            email: 'e@example.com',
            walletAddress: 'GCOLLABORATOR_E',
            revenueSharePercent: 50, // 60 + 50 = 110% — invalid
          },
        ],
      })
    )

    const req = makeRequest({
      invoiceId: 'inv-1',
      clientEmail: 'client@example.com',
    })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error).toMatch(/100%/i)
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockSendStellarPayment).not.toHaveBeenCalled()
  })
})
