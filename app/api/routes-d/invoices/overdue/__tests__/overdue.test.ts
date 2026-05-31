import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
  default: { error: vi.fn() },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findMany)

function getReq(auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/invoices/overdue', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
  mockedInvoiceFind.mockResolvedValue([])
})

describe('GET /api/routes-d/invoices/overdue', () => {
  it('returns 401 when authorization header is missing', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(getReq(''))
    expect(res.status).toBe(401)
  })

  it('returns 401 for an invalid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user does not exist', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    const res = await GET(getReq())
    expect(res.status).toBe(404)
  })

  it('returns an empty list when there are no overdue invoices', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.invoices).toEqual([])
    expect(json.count).toBe(0)
  })

  it('returns overdue invoices with the correct shape', async () => {
    mockedInvoiceFind.mockResolvedValue([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-001',
        clientName: 'Acme Corp',
        amount: 500,
        currency: 'USDC',
        dueDate: THREE_DAYS_AGO,
      },
    ] as never)

    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.count).toBe(1)
    expect(json.invoices[0]).toMatchObject({
      id: 'inv-1',
      invoiceNumber: 'INV-001',
      clientName: 'Acme Corp',
      currency: 'USDC',
    })
  })

  it('calculates daysOverdue correctly', async () => {
    mockedInvoiceFind.mockResolvedValue([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-001',
        clientName: 'Acme Corp',
        amount: 100,
        currency: 'USDC',
        dueDate: THREE_DAYS_AGO,
      },
    ] as never)

    const res = await GET(getReq())
    const json = await res.json()
    expect(json.invoices[0].daysOverdue).toBeGreaterThanOrEqual(2)
    expect(json.invoices[0].daysOverdue).toBeLessThanOrEqual(4)
  })

  it('converts Decimal amounts to numbers', async () => {
    mockedInvoiceFind.mockResolvedValue([
      {
        id: 'inv-2',
        invoiceNumber: 'INV-002',
        clientName: 'Beta Ltd',
        amount: '250.50',
        currency: 'USDC',
        dueDate: THREE_DAYS_AGO,
      },
    ] as never)

    const res = await GET(getReq())
    const json = await res.json()
    expect(typeof json.invoices[0].amount).toBe('number')
    expect(json.invoices[0].amount).toBe(250.5)
  })

  it('returns multiple overdue invoices in ascending due-date order', async () => {
    const older = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    mockedInvoiceFind.mockResolvedValue([
      {
        id: 'inv-older',
        invoiceNumber: 'INV-001',
        clientName: 'A',
        amount: 100,
        currency: 'USDC',
        dueDate: older,
      },
      {
        id: 'inv-newer',
        invoiceNumber: 'INV-002',
        clientName: 'B',
        amount: 200,
        currency: 'USDC',
        dueDate: THREE_DAYS_AGO,
      },
    ] as never)

    const res = await GET(getReq())
    const json = await res.json()
    expect(json.count).toBe(2)
    expect(json.invoices[0].id).toBe('inv-older')
    expect(json.invoices[1].id).toBe('inv-newer')
  })

  it('returns 500 on a database error', async () => {
    mockedInvoiceFind.mockRejectedValue(new Error('DB failure') as never)
    const res = await GET(getReq())
    expect(res.status).toBe(500)
  })
})