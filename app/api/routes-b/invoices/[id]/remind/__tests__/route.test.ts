import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { sendEmail } from '@/lib/email'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedSendEmail = vi.mocked(sendEmail)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)

const invoiceId = '550e8400-e29b-41d4-a716-446655440000'
const userId = 'user-1'

const pendingInvoice = {
  id: invoiceId,
  userId,
  status: 'pending',
  clientEmail: 'client@example.com',
  invoiceNumber: 'INV-001',
  amount: '500.00',
  currency: 'USD',
  dueDate: new Date('2099-01-15T00:00:00.000Z'),
  paymentLink: 'https://app.example/pay/INV-001',
}

function makePOST(id = invoiceId, auth = true): NextRequest {
  return new NextRequest(`http://localhost/api/routes-b/invoices/${id}/remind`, {
    method: 'POST',
    headers: auth ? { authorization: 'Bearer token' } : {},
  })
}

function makeParams(id = invoiceId) {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/routes-b/invoices/[id]/remind', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: userId } as never)
    mockedInvoiceFind.mockResolvedValue(pendingInvoice as never)
    mockedSendEmail.mockResolvedValue(undefined as never)
  })

  it('sends a reminder for an owned pending invoice', async () => {
    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      sent: true,
      invoiceId,
      clientEmail: 'client@example.com',
      invoiceNumber: 'INV-001',
    })
    expect(mockedInvoiceFind).toHaveBeenCalledWith({
      where: { id: invoiceId },
      select: {
        id: true,
        userId: true,
        status: true,
        clientEmail: true,
        invoiceNumber: true,
        amount: true,
        currency: true,
        dueDate: true,
        paymentLink: true,
      },
    })
    expect(mockedSendEmail).toHaveBeenCalledWith({
      to: 'client@example.com',
      subject: 'Payment reminder: INV-001',
      html: expect.stringContaining('500.00 USD'),
    })
  })

  it('renders Not set when due date is absent', async () => {
    mockedInvoiceFind.mockResolvedValue({
      ...pendingInvoice,
      dueDate: null,
    } as never)

    const res = await POST(makePOST(), makeParams())

    expect(res.status).toBe(200)
    expect(mockedSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('Not set'),
      }),
    )
  })

  it('returns 401 when authorization is missing', async () => {
    const res = await POST(makePOST(invoiceId, false), makeParams())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
    expect(mockedSendEmail).not.toHaveBeenCalled()
  })

  it('returns 401 when token verification fails', async () => {
    mockedVerify.mockResolvedValue(null as never)

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
    expect(mockedSendEmail).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-UUID invoice id', async () => {
    const res = await POST(makePOST('not-a-uuid'), makeParams('not-a-uuid'))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields.id).toBe('Must be a valid UUID')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
    expect(mockedSendEmail).not.toHaveBeenCalled()
  })

  it('returns 404 when the user cannot be resolved', async () => {
    mockedUserFind.mockResolvedValue(null)

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('User not found')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
    expect(mockedSendEmail).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist', async () => {
    mockedInvoiceFind.mockResolvedValue(null)

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Invoice not found')
    expect(mockedSendEmail).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({
      ...pendingInvoice,
      userId: 'other-user',
    } as never)

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(mockedSendEmail).not.toHaveBeenCalled()
  })

  it('returns 422 when the invoice is not pending', async () => {
    mockedInvoiceFind.mockResolvedValue({
      ...pendingInvoice,
      status: 'paid',
    } as never)

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.message).toBe('Reminders can only be sent for pending invoices')
    expect(mockedSendEmail).not.toHaveBeenCalled()
  })

  it('returns 500 when email sending fails', async () => {
    mockedSendEmail.mockRejectedValue(new Error('resend down'))

    const res = await POST(makePOST(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error.code).toBe('INTERNAL')
    expect(body.error.message).toBe('Failed to send invoice reminder')
  })
})
