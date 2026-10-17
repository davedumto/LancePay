import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'

const state = vi.hoisted(() => ({
  applicationRows: [] as { id: string; creditNoteId: string; invoiceId: string; amount: Decimal; createdAt: Date }[],
  transactionCalls: 0,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    creditNote: { findFirst: vi.fn() },
    creditNoteApplication: { findMany: vi.fn() },
    invoice: { findFirst: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      state.transactionCalls += 1
      return callback({
        creditNoteApplication: {
          aggregate: vi.fn(async () => ({
            _sum: {
              amount: state.applicationRows.reduce<Decimal>(
                (sum: Decimal, row: { amount: Decimal }) => sum.plus(row.amount),
                new Decimal(0),
              ),
            },
          })),
          create: vi.fn(async ({ data }: { data: { creditNoteId: string; invoiceId: string; amount: Decimal } }) => {
            const row = { id: `app-${state.applicationRows.length + 1}`, ...data, createdAt: new Date('2026-10-01T00:00:00Z') }
            state.applicationRows.push(row)
            return row
          }),
        },
        creditNote: { updateMany: vi.fn(async () => ({ count: 1 })) },
        invoice: { updateMany: vi.fn(async () => ({ count: 1 })) },
      })
    }),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const noteFind = vi.mocked(prisma.creditNote.findFirst)
const invoiceFind = vi.mocked(prisma.invoice.findFirst)

function request(method: 'GET' | 'POST', body?: unknown) {
  return new NextRequest('http://localhost/api/credit-notes/cn-1/applications', {
    method,
    headers: { authorization: 'Bearer valid', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
}

function params() {
  return { params: Promise.resolve({ id: 'cn-1' }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.applicationRows.splice(0)
  state.transactionCalls = 0
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  noteFind.mockResolvedValue({
    id: 'cn-1', amount: new Decimal(100), appliedAmount: new Decimal(0), currency: 'USD', status: 'issued',
    invoice: { clientEmail: 'client@example.com' },
  } as never)
  invoiceFind.mockResolvedValue({
    id: 'inv-1', amount: new Decimal(100), currency: 'USD', status: 'pending', clientEmail: 'client@example.com',
  } as never)
  vi.mocked(prisma.creditNoteApplication.findMany).mockResolvedValue([] as never)
})

describe('/api/credit-notes/[id]/applications', () => {
  it('lists applications and computes the remaining balance', async () => {
    state.applicationRows.push({ id: 'app-1', creditNoteId: 'cn-1', invoiceId: 'inv-1', amount: new Decimal(25), createdAt: new Date() })
    vi.mocked(prisma.creditNoteApplication.findMany).mockResolvedValue(state.applicationRows as never)
    const response = await GET(request('GET'), params())
    expect(response.status).toBe(200)
    expect((await response.json()).remainingBalance).toBe(75)
  })

  it('creates a credit application and reports the shrinking balance', async () => {
    const response = await POST(request('POST', { invoiceId: 'inv-1', amount: 30 }), params())
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.application).toMatchObject({ invoiceId: 'inv-1', amount: 30 })
    expect(body.remainingBalance).toBe(70)
  })

  it('rejects an application exceeding the balance left after prior applications', async () => {
    state.applicationRows.push({ id: 'app-1', creditNoteId: 'cn-1', invoiceId: 'inv-1', amount: new Decimal(80), createdAt: new Date() })
    const response = await POST(request('POST', { invoiceId: 'inv-1', amount: 30 }), params())
    expect(response.status).toBe(422)
    expect(state.transactionCalls).toBe(1)
  })

  it('rejects a missing invoice id', async () => {
    const response = await POST(request('POST', { amount: 10 }), params())
    expect(response.status).toBe(400)
    expect(state.transactionCalls).toBe(0)
  })
})