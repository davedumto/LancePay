import { NextRequest } from 'next/server'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { POST } from './route'
import { prisma } from '@/lib/db'
import { sendPaymentReceivedEmail, sendAdminAlertEmail } from '@/lib/email'
import { logger } from '@/lib/logger'
import { verifyMoonPaySignatureV2 } from '@/lib/moonpay-signature'

vi.mock('@/lib/db')
vi.mock('@/lib/email')
vi.mock('@/lib/logger')
vi.mock('@/lib/moonpay-signature')

const INVOICE_ID = '00000000-0000-4000-8000-000000000000'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const MOONPAY_TX_ID = 'moonpay-tx-12345'
const INVOICE_NUMBER = 'INV-001'

const mockInvoice = {
  id: INVOICE_ID,
  userId: USER_ID,
  invoiceNumber: INVOICE_NUMBER,
  clientName: 'Test Client',
  clientEmail: 'client@example.com',
  description: 'Test invoice',
  amount: new Decimal('100.00'),
  currency: 'USD',
  status: 'pending',
  paymentLink: 'http://pay.test/inv-001',
  dueDate: null,
  paidAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  user: {
    id: USER_ID,
    email: 'freelancer@example.com',
    name: 'Test Freelancer',
  },
}

function makeRequest(body: any, signature = 'valid-sig') {
  const jsonBody = JSON.stringify(body)
  return new NextRequest('http://localhost:3000/api/webhooks/moonpay', {
    method: 'POST',
    headers: {
      'moonpay-signature-v2': signature,
      'content-type': 'application/json',
    },
    body: jsonBody,
  })
}

describe('POST /api/webhooks/moonpay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyMoonPaySignatureV2).mockReturnValue(true)
    vi.mocked(logger.info).mockImplementation(() => {})
    vi.mocked(logger.warn).mockImplementation(() => {})
    vi.mocked(logger.error).mockImplementation(() => {})
  })

  it('returns 401 on invalid signature', async () => {
    vi.mocked(verifyMoonPaySignatureV2).mockReturnValue(false)
    const body = { type: 'transaction_completed', data: { status: 'completed' } }
    const req = makeRequest(body, 'invalid-sig')

    const res = await POST(req)
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Invalid signature')
  })

  it('returns 400 on invalid JSON', async () => {
    const req = new NextRequest('http://localhost:3000/api/webhooks/moonpay', {
      method: 'POST',
      headers: {
        'moonpay-signature-v2': 'valid-sig',
      },
      body: 'invalid json {',
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid JSON')
  })

  it('returns 200 for non-transaction_completed events', async () => {
    const body = { type: 'transaction_pending', data: { status: 'pending' } }
    const req = makeRequest(body)

    const res = await POST(req)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.received).toBe(true)
  })

  it('returns 200 when no externalTransactionId provided', async () => {
    const body = { type: 'transaction_completed', data: { status: 'completed' } }
    const req = makeRequest(body)

    const res = await POST(req)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.received).toBe(true)
  })

  it('returns 200 for idempotent duplicate (externalId already exists)', async () => {
    const body = {
      type: 'transaction_completed',
      data: {
        status: 'completed',
        externalTransactionId: INVOICE_NUMBER,
        id: MOONPAY_TX_ID,
        quoteCurrencyAmount: '100.00',
        quoteCurrency: 'USD',
      },
    }

    vi.mocked(prisma.transaction.findUnique).mockResolvedValue({
      id: 'existing-tx-123',
      externalId: MOONPAY_TX_ID,
    } as any)

    const req = makeRequest(body)
    const res = await POST(req)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.received).toBe(true)
    expect(vi.mocked(logger.info).mock.calls.some((call) =>
      call[1]?.includes('idempotent duplicate'),
    )).toBe(true)
  })

  it('returns 200 when invoice not found', async () => {
    const body = {
      type: 'transaction_completed',
      data: {
        status: 'completed',
        externalTransactionId: INVOICE_NUMBER,
        id: MOONPAY_TX_ID,
        quoteCurrencyAmount: '100.00',
        quoteCurrency: 'USD',
      },
    }

    vi.mocked(prisma.transaction.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(null)

    const req = makeRequest(body)
    const res = await POST(req)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.received).toBe(true)
  })

  it('returns 200 when invoice already paid', async () => {
    const body = {
      type: 'transaction_completed',
      data: {
        status: 'completed',
        externalTransactionId: INVOICE_NUMBER,
        id: MOONPAY_TX_ID,
        quoteCurrencyAmount: '100.00',
        quoteCurrency: 'USD',
      },
    }

    vi.mocked(prisma.transaction.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({
      ...mockInvoice,
      status: 'paid',
    })

    const req = makeRequest(body)
    const res = await POST(req)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.received).toBe(true)
  })

  it('processes exact payment amount and currency', async () => {
    const body = {
      type: 'transaction_completed',
      data: {
        status: 'completed',
        externalTransactionId: INVOICE_NUMBER,
        id: MOONPAY_TX_ID,
        quoteCurrencyAmount: '100.00',
        quoteCurrency: 'USD',
      },
    }

    vi.mocked(prisma.transaction.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice)

    const mockTx = {
      invoice: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      transaction: {
        create: vi.fn().mockResolvedValue({
          id: 'tx-123',
        }),
      },
    }
    vi.mocked(prisma.$transaction).mockImplementation((cb) => cb(mockTx))
    vi.mocked(sendPaymentReceivedEmail).mockResolvedValue(undefined)

    const req = makeRequest(body)
    const res = await POST(req)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.received).toBe(true)

    expect(mockTx.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INVOICE_ID, status: 'pending' },
        data: expect.objectContaining({ status: 'paid' }),
      }),
    )

    expect(mockTx.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          invoiceId: INVOICE_ID,
          amount: mockInvoice.amount,
          currency: 'USD',
          externalId: MOONPAY_TX_ID,
        }),
      }),
    )

    expect(vi.mocked(sendPaymentReceivedEmail)).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'freelancer@example.com',
        invoiceNumber: INVOICE_NUMBER,
        amount: 100,
        currency: 'USD',
      }),
    )
  })

  it('flags underpayment and creates admin alert', async () => {
    const body = {
      type: 'transaction_completed',
      data: {
        status: 'completed',
        externalTransactionId: INVOICE_NUMBER,
        id: MOONPAY_TX_ID,
        quoteCurrencyAmount: '50.00', // Underpayment
        quoteCurrency: 'USD',
      },
    }

    vi.mocked(prisma.transaction.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice)
    vi.mocked(prisma.structuringFlag.create).mockResolvedValue({
      id: 'flag-123',
    } as any)
    vi.mocked(sendAdminAlertEmail).mockResolvedValue(undefined)

    const req = makeRequest(body)
    const res = await POST(req)

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.received).toBe(true)

    expect(vi.mocked(prisma.structuringFlag.create)).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        status: 'open',
        reason: expect.stringContaining('mismatch'),
      }),
    })

    expect(vi.mocked(sendAdminAlertEmail)).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'MoonPay Payment Mismatch Alert',
        message: expect.stringContaining('50.00'),
      }),
    )

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        settledAmount: '50.00',
        invoiceAmount: mockInvoice.amount,
      }),
      expect.stringContaining('mismatch'),
    )
  })

  it('flags overpayment and creates admin alert', async () => {
    const body = {
      type: 'transaction_completed',
      data: {
        status: 'completed',
        externalTransactionId: INVOICE_NUMBER,
        id: MOONPAY_TX_ID,
        quoteCurrencyAmount: '150.00', // Overpayment
        quoteCurrency: 'USD',
      },
    }

    vi.mocked(prisma.transaction.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice)
    vi.mocked(prisma.structuringFlag.create).mockResolvedValue({
      id: 'flag-456',
    } as any)
    vi.mocked(sendAdminAlertEmail).mockResolvedValue(undefined)

    const req = makeRequest(body)
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.structuringFlag.create)).toHaveBeenCalled()
    expect(vi.mocked(sendAdminAlertEmail)).toHaveBeenCalled()
  })

  it('flags wrong currency and creates admin alert', async () => {
    const body = {
      type: 'transaction_completed',
      data: {
        status: 'completed',
        externalTransactionId: INVOICE_NUMBER,
        id: MOONPAY_TX_ID,
        quoteCurrencyAmount: '100.00',
        quoteCurrency: 'EUR', // Wrong currency
      },
    }

    vi.mocked(prisma.transaction.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice)
    vi.mocked(prisma.structuringFlag.create).mockResolvedValue({
      id: 'flag-789',
    } as any)
    vi.mocked(sendAdminAlertEmail).mockResolvedValue(undefined)

    const req = makeRequest(body)
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.structuringFlag.create)).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reason: expect.stringContaining('EUR'),
      }),
    })
  })

  it('handles missing settled currency gracefully', async () => {
    const body = {
      type: 'transaction_completed',
      data: {
        status: 'completed',
        externalTransactionId: INVOICE_NUMBER,
        id: MOONPAY_TX_ID,
        quoteCurrencyAmount: '100.00',
        // quoteCurrency is missing
      },
    }

    vi.mocked(prisma.transaction.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice)

    const mockTx = {
      invoice: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      transaction: {
        create: vi.fn().mockResolvedValue({ id: 'tx-123' }),
      },
    }
    vi.mocked(prisma.$transaction).mockImplementation((cb) => cb(mockTx))
    vi.mocked(sendPaymentReceivedEmail).mockResolvedValue(undefined)

    const req = makeRequest(body)
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockTx.transaction.create).toHaveBeenCalled()
  })

  it('does not mark invoice paid when underpayment is detected', async () => {
    const body = {
      type: 'transaction_completed',
      data: {
        status: 'completed',
        externalTransactionId: INVOICE_NUMBER,
        id: MOONPAY_TX_ID,
        quoteCurrencyAmount: '50.00',
        quoteCurrency: 'USD',
      },
    }

    vi.mocked(prisma.transaction.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice)
    vi.mocked(prisma.structuringFlag.create).mockResolvedValue({
      id: 'flag-123',
    } as any)
    vi.mocked(sendAdminAlertEmail).mockResolvedValue(undefined)

    const mockTx = {
      invoice: {
        updateMany: vi.fn(),
      },
      transaction: {
        create: vi.fn(),
      },
    }
    vi.mocked(prisma.$transaction).mockImplementation((cb) => cb(mockTx))

    const req = makeRequest(body)
    await POST(req)

    // Should NOT have called updateMany or create transaction on mismatch
    expect(mockTx.invoice.updateMany).not.toHaveBeenCalled()
    expect(mockTx.transaction.create).not.toHaveBeenCalled()
  })
})
