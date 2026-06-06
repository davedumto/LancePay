import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/utils', () => ({ generateInvoiceNumber: vi.fn(() => 'INV-TEST-COPY') }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockedInvoiceCreate = vi.mocked(prisma.invoice.create)

const INVOICE_ID = 'inv-original'
const USER_ID = 'user-1'

const originalInvoice = {
  id: INVOICE_ID,
  userId: USER_ID,
  invoiceNumber: 'INV-ORIG',
  clientEmail: 'client@example.com',
  clientName: 'Alice',
  description: 'Original work',
  amount: 500,
  currency: 'USD',
  status: 'paid',
  paymentLink: 'https://app/pay/INV-ORIG',
  dueDate: new Date('2026-01-15'),
  paidAt: new Date('2026-01-20'),
  createdAt: new Date(),
  updatedAt: new Date(),
}

const createdInvoice = {
  id: 'inv-new',
  userId: USER_ID,
  invoiceNumber: 'INV-TEST-COPY',
  clientEmail: 'client@example.com',
  clientName: 'Alice',
  description: 'Original work',
  amount: 500,
  currency: 'USD',
  status: 'pending',
  paymentLink: 'https://app/pay/INV-TEST-COPY',
  dueDate: null,
  paidAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

function makeRequest(auth = 'Bearer token'): NextRequest {
  return new NextRequest(
    `http://localhost/api/routes-d/invoices/${INVOICE_ID}/duplicate`,
    {
      method: 'POST',
      headers: auth ? { authorization: auth } : {},
    },
  )
}

const params = { params: Promise.resolve({ id: INVOICE_ID }) }

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: USER_ID } as never)
  mockedInvoiceFind.mockResolvedValue(originalInvoice as never)
  mockedInvoiceCreate.mockResolvedValue(createdInvoice as never)
})

describe('POST /api/routes-d/invoices/[id]/duplicate', () => {
  it('returns 401 when no token is supplied', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await POST(makeRequest(''), params)).status).toBe(401)
  })

  it('returns 401 when token does not verify', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await POST(makeRequest(), params)).status).toBe(401)
  })

  it('returns 404 when user cannot be resolved from claims', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await POST(makeRequest(), params)).status).toBe(404)
  })

  it('returns 404 when the original invoice does not exist', async () => {
    mockedInvoiceFind.mockResolvedValue(null as never)
    expect((await POST(makeRequest(), params)).status).toBe(404)
  })

  it('returns 403 when the invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...originalInvoice, userId: 'other-user' } as never)
    expect((await POST(makeRequest(), params)).status).toBe(403)
  })

  it('returns 201 with the new invoice on success', async () => {
    const res = await POST(makeRequest(), params)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBe('inv-new')
    expect(body.invoiceNumber).toBe('INV-TEST-COPY')
  })

  it('creates the new invoice with status=pending and dueDate=null', async () => {
    await POST(makeRequest(), params)
    expect(mockedInvoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'pending',
          dueDate: null,
          paidAt: null,
          invoiceNumber: 'INV-TEST-COPY',
        }),
      }),
    )
  })

  it('copies client and description fields from the original invoice', async () => {
    await POST(makeRequest(), params)
    expect(mockedInvoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientEmail: 'client@example.com',
          clientName: 'Alice',
          description: 'Original work',
          amount: 500,
          currency: 'USD',
        }),
      }),
    )
  })
})
