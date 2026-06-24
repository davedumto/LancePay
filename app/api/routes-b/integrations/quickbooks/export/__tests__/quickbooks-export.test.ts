import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findMany)
const mockedTxFind = vi.mocked(prisma.transaction.findMany)

function makePost(body: unknown, auth: string | null = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/integrations/quickbooks/export', {
    method: 'POST',
    headers: {
      ...(auth ? { authorization: auth } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-b/integrations/quickbooks/export', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
  })

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost({ entityType: 'invoices' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid entityType', async () => {
    const res = await POST(makePost({ entityType: 'unknownType' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/entityType/)
  })

  it('returns 400 for missing entityType', async () => {
    const res = await POST(makePost({}))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/integrations/quickbooks/export', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: 'not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid from date', async () => {
    const res = await POST(makePost({ entityType: 'invoices', from: 'bad-date' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/from/i)
  })

  it('exports invoices successfully', async () => {
    mockedInvoiceFind.mockResolvedValue([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-001',
        clientEmail: 'a@b.com',
        clientName: 'Alice',
        amount: 150,
        currency: 'USDC',
        status: 'paid',
        dueDate: null,
        createdAt: new Date('2024-01-01'),
      },
    ] as never)

    const res = await POST(makePost({ entityType: 'invoices' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.export.entityType).toBe('invoices')
    expect(json.export.count).toBe(1)
    expect(json.export.records[0].amount).toBe(150)
    expect(json.export.exportedAt).toBeTruthy()
  })

  it('exports transactions successfully', async () => {
    mockedTxFind.mockResolvedValue([
      {
        id: 'tx-1',
        type: 'payment',
        status: 'completed',
        amount: 200,
        currency: 'USDC',
        createdAt: new Date('2024-02-01'),
      },
    ] as never)

    const res = await POST(makePost({ entityType: 'transactions' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.export.entityType).toBe('transactions')
    expect(json.export.count).toBe(1)
  })

  it('exports clients (distinct emails) successfully', async () => {
    mockedInvoiceFind.mockResolvedValue([
      { clientEmail: 'a@b.com', clientName: 'Alice' },
      { clientEmail: 'c@d.com', clientName: 'Bob' },
    ] as never)

    const res = await POST(makePost({ entityType: 'clients' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.export.entityType).toBe('clients')
    expect(json.export.count).toBe(2)
  })

  it('returns 500 on unexpected error', async () => {
    mockedInvoiceFind.mockRejectedValue(new Error('DB error') as never)
    const res = await POST(makePost({ entityType: 'invoices' }))
    expect(res.status).toBe(500)
  })
})
