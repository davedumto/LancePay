import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockCreditNoteFindUnique = vi.fn()
const mockCreditNoteUpdate = vi.fn()
const mockApplicationFindMany = vi.fn()
const mockApplicationCreate = vi.fn()
const mockInvoiceFindUnique = vi.fn()
const mockInvoiceUpdate = vi.fn()

const txClient = {
  creditNote: {
    findUnique: (...args: unknown[]) => mockCreditNoteFindUnique(...args),
    update: (...args: unknown[]) => mockCreditNoteUpdate(...args),
  },
  creditNoteApplication: {
    findMany: (...args: unknown[]) => mockApplicationFindMany(...args),
    create: (...args: unknown[]) => mockApplicationCreate(...args),
  },
  invoice: {
    findUnique: (...args: unknown[]) => mockInvoiceFindUnique(...args),
    update: (...args: unknown[]) => mockInvoiceUpdate(...args),
  },
}

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    creditNote: {
      findUnique: (...args: unknown[]) => mockCreditNoteFindUnique(...args),
      update: (...args: unknown[]) => mockCreditNoteUpdate(...args),
    },
    creditNoteApplication: {
      findMany: (...args: unknown[]) => mockApplicationFindMany(...args),
      create: (...args: unknown[]) => mockApplicationCreate(...args),
    },
    invoice: {
      findUnique: (...args: unknown[]) => mockInvoiceFindUnique(...args),
      update: (...args: unknown[]) => mockInvoiceUpdate(...args),
    },
    $transaction: vi.fn(async (cb: (tx: typeof txClient) => unknown) =>
      cb(txClient),
    ),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { GET, POST } from './route'

function makeRequest(
  url: string,
  options?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Credit Note Applications API (/api/credit-notes/[id]/applications)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
  })

  it('rejects an application amount that would exceed the credit note remaining balance computed from existing applications', async () => {
    mockCreditNoteFindUnique.mockResolvedValue({
      id: 'cn-1',
      userId: 'user-1',
      amount: 100,
      appliedAmount: 60,
      currency: 'USD',
      status: 'issued',
    })

    // Existing applications sum to 60 -> remaining balance is 40
    mockApplicationFindMany.mockResolvedValue([
      {
        id: 'app-1',
        creditNoteId: 'cn-1',
        invoiceId: 'inv-1',
        amount: 35,
        createdAt: new Date('2026-04-01T10:00:00Z'),
      },
      {
        id: 'app-2',
        creditNoteId: 'cn-1',
        invoiceId: 'inv-2',
        amount: 25,
        createdAt: new Date('2026-04-02T10:00:00Z'),
      },
    ])

    const req = makeRequest(
      'http://localhost/api/credit-notes/cn-1/applications',
      {
        token: 'valid-token',
        body: { invoiceId: 'inv-3', amount: 45 },
      },
    )

    const res = await POST(req, { params: { id: 'cn-1' } })
    expect(res.status).toBe(400)

    const json = await res.json()
    expect(json.code).toBe('INSUFFICIENT_CREDIT_NOTE_BALANCE')
    expect(json.remainingBalance).toBe(40)
    expect(json.appliedAmount).toBe(60)
    expect(mockApplicationCreate).not.toHaveBeenCalled()
  })

  it('supports applying the same credit note across multiple invoices in separate calls, each respecting the shrinking remaining balance', async () => {
    const applicationsStore: Array<{
      id: string
      creditNoteId: string
      invoiceId: string
      amount: number
      createdAt: Date
    }> = []

    mockCreditNoteFindUnique.mockResolvedValue({
      id: 'cn-1',
      userId: 'user-1',
      amount: 100,
      appliedAmount: 0,
      currency: 'USD',
      status: 'issued',
    })

    mockApplicationFindMany.mockImplementation(async () => [
      ...applicationsStore,
    ])

    mockApplicationCreate.mockImplementation(async ({ data }: any) => {
      const created = {
        id: `app-${applicationsStore.length + 1}`,
        creditNoteId: data.creditNoteId,
        invoiceId: data.invoiceId,
        amount: data.amount,
        createdAt: new Date('2026-04-03T10:00:00Z'),
      }
      applicationsStore.push(created)
      return created
    })

    mockInvoiceFindUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'inv-a') {
        return {
          id: 'inv-a',
          userId: 'user-1',
          amount: 80,
          currency: 'USD',
          status: 'pending',
        }
      }
      if (where.id === 'inv-b') {
        return {
          id: 'inv-b',
          userId: 'user-1',
          amount: 50,
          currency: 'USD',
          status: 'overdue',
        }
      }
      return null
    })

    // First call: apply $60 against inv-a -> remaining credit balance becomes $40
    const req1 = makeRequest(
      'http://localhost/api/credit-notes/cn-1/applications',
      {
        token: 'valid-token',
        body: { invoiceId: 'inv-a', amount: 60 },
      },
    )
    const res1 = await POST(req1, { params: { id: 'cn-1' } })
    expect(res1.status).toBe(201)
    const json1 = await res1.json()
    expect(json1.application.invoiceId).toBe('inv-a')
    expect(json1.application.amount).toBe(60)
    expect(json1.creditNote.appliedAmount).toBe(60)
    expect(json1.creditNote.remainingBalance).toBe(40)
    expect(json1.creditNote.status).toBe('issued')

    // Second call: attempt to apply $50 against inv-b -> rejected because only $40 remains
    const reqTooMuch = makeRequest(
      'http://localhost/api/credit-notes/cn-1/applications',
      {
        token: 'valid-token',
        body: { invoiceId: 'inv-b', amount: 50 },
      },
    )
    const resTooMuch = await POST(reqTooMuch, { params: { id: 'cn-1' } })
    expect(resTooMuch.status).toBe(400)
    const jsonTooMuch = await resTooMuch.json()
    expect(jsonTooMuch.code).toBe('INSUFFICIENT_CREDIT_NOTE_BALANCE')
    expect(jsonTooMuch.remainingBalance).toBe(40)

    // Third call: apply the exact remaining $40 against inv-b -> remaining balance becomes $0 and status becomes 'applied'
    const req2 = makeRequest(
      'http://localhost/api/credit-notes/cn-1/applications',
      {
        token: 'valid-token',
        body: { invoiceId: 'inv-b', amount: 40 },
      },
    )
    const res2 = await POST(req2, { params: { id: 'cn-1' } })
    expect(res2.status).toBe(201)
    const json2 = await res2.json()
    expect(json2.application.invoiceId).toBe('inv-b')
    expect(json2.application.amount).toBe(40)
    expect(json2.creditNote.appliedAmount).toBe(100)
    expect(json2.creditNote.remainingBalance).toBe(0)
    expect(json2.creditNote.status).toBe('applied')
  })

  it('lists existing CreditNoteApplication rows and remaining balance via GET', async () => {
    mockCreditNoteFindUnique.mockResolvedValue({
      id: 'cn-1',
      userId: 'user-1',
      amount: 100,
      appliedAmount: 45,
      currency: 'USD',
      status: 'issued',
    })
    mockApplicationFindMany.mockResolvedValue([
      {
        id: 'app-1',
        creditNoteId: 'cn-1',
        invoiceId: 'inv-1',
        amount: 45,
        createdAt: new Date('2026-04-01T10:00:00Z'),
      },
    ])

    const req = makeRequest(
      'http://localhost/api/credit-notes/cn-1/applications',
      {
        method: 'GET',
        token: 'valid-token',
      },
    )

    const res = await GET(req, { params: { id: 'cn-1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.amount).toBe(100)
    expect(json.appliedAmount).toBe(45)
    expect(json.remainingBalance).toBe(55)
    expect(json.applications).toHaveLength(1)
  })
})
