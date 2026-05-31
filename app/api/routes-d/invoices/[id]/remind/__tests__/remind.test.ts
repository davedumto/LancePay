import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn() }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { sendEmail } from '@/lib/email'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockedSend = vi.mocked(sendEmail)

const params = { params: Promise.resolve({ id: 'inv-1' }) }

function req(auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/invoices/inv-1/remind', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  })
}

const pendingInvoice = {
  userId: 'user-1',
  status: 'pending',
  clientEmail: 'client@example.com',
  invoiceNumber: 'INV-001',
  amount: 100,
  currency: 'USD',
  dueDate: null,
  paymentLink: 'https://pay/inv-1',
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

describe('POST /api/routes-d/invoices/[id]/remind', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await POST(req(''), params)).status).toBe(401)
  })

  it('returns 404 when the user cannot be resolved', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await POST(req(), params)).status).toBe(404)
  })

  it('returns 404 when the invoice does not exist', async () => {
    mockedInvoiceFind.mockResolvedValue(null as never)
    expect((await POST(req(), params)).status).toBe(404)
  })

  it('returns 403 when the invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...pendingInvoice, userId: 'other' } as never)
    expect((await POST(req(), params)).status).toBe(403)
  })

  it('returns 422 when the invoice is not pending', async () => {
    mockedInvoiceFind.mockResolvedValue({ ...pendingInvoice, status: 'paid' } as never)
    expect((await POST(req(), params)).status).toBe(422)
  })

  it('sends the reminder for a pending invoice', async () => {
    mockedInvoiceFind.mockResolvedValue(pendingInvoice as never)
    mockedSend.mockResolvedValue(undefined as never)
    const res = await POST(req(), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sent: true, clientEmail: 'client@example.com' })
    expect(mockedSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'client@example.com' }),
    )
  })
})
