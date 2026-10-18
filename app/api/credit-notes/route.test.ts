import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    creditNote: {
      count: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const NOW = new Date('2026-10-17T12:00:00.000Z')

function makeGetRequest(query = '', token: string | null = 'valid-token'): NextRequest {
  const suffix = query ? `?${query}` : ''
  return new NextRequest(`http://localhost/api/credit-notes${suffix}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

function makePostRequest(body?: unknown, token: string | null = 'valid-token'): NextRequest {
  return new NextRequest('http://localhost/api/credit-notes', {
    method: 'POST',
    headers: token
      ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('GET & POST /api/credit-notes (#1678)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as any)
  })

  it('POST creates a credit note with unique creditNumber, appliedAmount=0, status="issued", and validates invoice ownership', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({
      id: 'inv-1',
      amount: new Decimal('500.00'),
      currency: 'USD',
    } as any)

    vi.mocked(prisma.creditNote.create).mockImplementation(
      (async (args: any) => ({
        id: 'cn-new-1',
        invoiceId: args.data.invoiceId,
        creditNumber: args.data.creditNumber,
        amount: new Decimal(String(args.data.amount)),
        appliedAmount: new Decimal(String(args.data.appliedAmount)),
        currency: args.data.currency,
        reason: args.data.reason,
        status: args.data.status,
        createdAt: NOW,
      })) as any,
    )

    const res = await POST(
      makePostRequest({
        invoiceId: 'inv-1',
        amount: 125.5,
        reason: 'Overcharge adjustment',
      }),
    )

    expect(res.status).toBe(201)
    const body = await res.json()

    expect(body.creditNote.id).toBe('cn-new-1')
    expect(body.creditNote.invoiceId).toBe('inv-1')
    expect(body.creditNote.creditNumber).toMatch(/^CN-[A-Z0-9]+-[A-F0-9]{8}$/)
    expect(body.creditNote.amount).toBe(125.5)
    expect(body.creditNote.appliedAmount).toBe(0)
    expect(body.creditNote.remainingBalance).toBe(125.5)
    expect(body.creditNote.status).toBe('issued')

    const createArgs = vi.mocked(prisma.creditNote.create).mock.calls[0][0] as any
    expect(createArgs.data.appliedAmount).toBe(0)
    expect(createArgs.data.status).toBe('issued')
  })

  it('POST retries generating a unique creditNumber when a P2002 collision occurs', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({
      id: 'inv-1',
      amount: new Decimal('500.00'),
      currency: 'USD',
    } as any)

    vi.mocked(prisma.creditNote.create)
      .mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }))
      .mockImplementationOnce(
        (async (args: any) => ({
          id: 'cn-retry-ok',
          invoiceId: args.data.invoiceId,
          creditNumber: args.data.creditNumber,
          amount: new Decimal(String(args.data.amount)),
          appliedAmount: new Decimal('0'),
          currency: args.data.currency,
          reason: args.data.reason,
          status: args.data.status,
          createdAt: NOW,
        })) as any,
      )

    const res = await POST(
      makePostRequest({ invoiceId: 'inv-1', amount: 50, reason: 'Retry test' }),
    )
    expect(res.status).toBe(201)
    expect(prisma.creditNote.create).toHaveBeenCalledTimes(2)
  })

  it('POST rejects non-positive amounts, amounts exceeding invoice total, and unowned/missing invoices', async () => {
    const zeroRes = await POST(
      makePostRequest({ invoiceId: 'inv-1', amount: 0, reason: 'Bad' }),
    )
    expect(zeroRes.status).toBe(400)

    const negRes = await POST(
      makePostRequest({ invoiceId: 'inv-1', amount: -20, reason: 'Bad' }),
    )
    expect(negRes.status).toBe(400)

    vi.mocked(prisma.invoice.findFirst).mockResolvedValueOnce(null)
    const missingInvRes = await POST(
      makePostRequest({ invoiceId: 'inv-other-user', amount: 50, reason: 'Not mine' }),
    )
    expect(missingInvRes.status).toBe(404)

    vi.mocked(prisma.invoice.findFirst).mockResolvedValueOnce({
      id: 'inv-1',
      amount: new Decimal('100.00'),
      currency: 'USD',
    } as any)
    const exceedRes = await POST(
      makePostRequest({ invoiceId: 'inv-1', amount: 150, reason: 'Too large' }),
    )
    expect(exceedRes.status).toBe(400)
  })

  it('GET lists credit notes for the authenticated user with pagination and status filtering', async () => {
    vi.mocked(prisma.creditNote.count).mockResolvedValue(1)
    vi.mocked(prisma.creditNote.findMany).mockResolvedValue([
      {
        id: 'cn-1',
        invoiceId: 'inv-1',
        creditNumber: 'CN-2026-0001',
        amount: new Decimal('200.00'),
        appliedAmount: new Decimal('50.00'),
        currency: 'USD',
        reason: 'Partial refund',
        status: 'issued',
        createdAt: NOW,
      },
    ] as any)

    const res = await GET(makeGetRequest('status=issued&page=1&limit=10'))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.creditNotes).toHaveLength(1)
    expect(body.creditNotes[0].amount).toBe(200)
    expect(body.creditNotes[0].appliedAmount).toBe(50)
    expect(body.creditNotes[0].remainingBalance).toBe(150)
    expect(body.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 1,
      totalPages: 1,
    })

    const badStatus = await GET(makeGetRequest('status=unknown'))
    expect(badStatus.status).toBe(400)
  })
})
