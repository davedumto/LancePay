import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    creditNote: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { GET } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const NOW = new Date('2026-10-17T12:00:00.000Z')

function makeRequest(id = 'cn-1', token: string | null = 'valid-token'): NextRequest {
  return new NextRequest(`http://localhost/api/credit-notes/${id}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('GET /api/credit-notes/[id] (#1679)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as any)
  })

  it('fetches a credit note with remainingBalance (amount - appliedAmount) and applied CreditNoteApplication rows', async () => {
    vi.mocked(prisma.creditNote.findUnique).mockResolvedValue({
      id: 'cn-1',
      userId: 'user-1',
      invoiceId: 'inv-orig-1',
      creditNumber: 'CN-2026-0001',
      amount: new Decimal('250.00'),
      appliedAmount: new Decimal('110.25'),
      currency: 'USD',
      reason: 'Service SLA credit',
      status: 'issued',
      createdAt: NOW,
      updatedAt: NOW,
      applications: [
        {
          id: 'app-1',
          invoiceId: 'inv-target-1',
          amount: new Decimal('60.25'),
          createdAt: new Date('2026-10-17T10:00:00.000Z'),
        },
        {
          id: 'app-2',
          invoiceId: 'inv-target-2',
          amount: new Decimal('50.00'),
          createdAt: new Date('2026-10-17T11:00:00.000Z'),
        },
      ],
    } as any)

    const res = await GET(makeRequest('cn-1'), { params: Promise.resolve({ id: 'cn-1' }) })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.creditNote).toEqual({
      id: 'cn-1',
      invoiceId: 'inv-orig-1',
      creditNumber: 'CN-2026-0001',
      amount: 250,
      appliedAmount: 110.25,
      remainingBalance: 139.75,
      currency: 'USD',
      reason: 'Service SLA credit',
      status: 'issued',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      applications: [
        {
          id: 'app-1',
          invoiceId: 'inv-target-1',
          amount: 60.25,
          createdAt: '2026-10-17T10:00:00.000Z',
        },
        {
          id: 'app-2',
          invoiceId: 'inv-target-2',
          amount: 50,
          createdAt: '2026-10-17T11:00:00.000Z',
        },
      ],
    })
  })

  it('returns remainingBalance=0 when the credit note has been fully applied', async () => {
    vi.mocked(prisma.creditNote.findUnique).mockResolvedValue({
      id: 'cn-2',
      userId: 'user-1',
      invoiceId: 'inv-1',
      creditNumber: 'CN-2026-0002',
      amount: new Decimal('100.00'),
      appliedAmount: new Decimal('100.00'),
      currency: 'USD',
      reason: 'Full credit',
      status: 'applied',
      createdAt: NOW,
      updatedAt: NOW,
      applications: [
        {
          id: 'app-full',
          invoiceId: 'inv-2',
          amount: new Decimal('100.00'),
          createdAt: NOW,
        },
      ],
    } as any)

    const res = await GET(makeRequest('cn-2'), { params: Promise.resolve({ id: 'cn-2' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.creditNote.remainingBalance).toBe(0)
    expect(body.creditNote.appliedAmount).toBe(100)
    expect(body.creditNote.applications).toHaveLength(1)
  })

  it("returns 403 when trying to access another user's credit note", async () => {
    vi.mocked(prisma.creditNote.findUnique).mockResolvedValue({
      id: 'cn-other',
      userId: 'other-user-99',
      invoiceId: 'inv-other',
      creditNumber: 'CN-OTHER',
      amount: new Decimal('50.00'),
      appliedAmount: new Decimal('0.00'),
      currency: 'USD',
      reason: 'Private',
      status: 'issued',
      createdAt: NOW,
      applications: [],
    } as any)

    const res = await GET(makeRequest('cn-other'), {
      params: Promise.resolve({ id: 'cn-other' }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the credit note does not exist', async () => {
    vi.mocked(prisma.creditNote.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest('cn-missing'), {
      params: Promise.resolve({ id: 'cn-missing' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated or token is invalid', async () => {
    const noTokenRes = await GET(makeRequest('cn-1', null), {
      params: Promise.resolve({ id: 'cn-1' }),
    })
    expect(noTokenRes.status).toBe(401)

    vi.mocked(verifyAuthToken).mockResolvedValueOnce(null)
    const badTokenRes = await GET(makeRequest('cn-1', 'bad'), {
      params: Promise.resolve({ id: 'cn-1' }),
    })
    expect(badTokenRes.status).toBe(401)
  })
})
