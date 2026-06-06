import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@react-pdf/renderer', () => ({
  renderToStream: vi.fn(),
}))
vi.mock('@/lib/pdf', () => ({
  InvoicePDF: vi.fn(() => null),
}))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    brandingSettings: { findUnique: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { renderToStream } from '@react-pdf/renderer'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockedBrandingFind = vi.mocked(prisma.brandingSettings.findUnique)
const mockedRenderToStream = vi.mocked(renderToStream)

const invoiceId = '550e8400-e29b-41d4-a716-446655440000'
const otherUserId = '660e8400-e29b-41d4-a716-446655440001'

const baseInvoice = {
  id: invoiceId,
  userId: 'user-1',
  invoiceNumber: 'INV-100',
  clientEmail: 'client@example.com',
  clientName: 'ACME',
  description: 'Design work',
  amount: 250,
  currency: 'USD',
  status: 'pending',
  paymentLink: 'https://pay.example/inv-100',
  dueDate: null,
  paidAt: null,
  createdAt: new Date('2026-01-15T00:00:00.000Z'),
}

function makeGET(id = invoiceId, auth = true): NextRequest {
  return new NextRequest(`http://localhost/api/routes-b/invoices/${id}/pdf`, {
    method: 'GET',
    headers: auth ? { authorization: 'Bearer token' } : {},
  })
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

describe('GET /api/routes-b/invoices/[id]/pdf', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({
      id: 'user-1',
      name: 'Jane Doe',
      email: 'jane@example.com',
    } as never)
    mockedBrandingFind.mockResolvedValue(null)
    mockedRenderToStream.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([37, 80, 68, 70]))
          controller.close()
        },
      }) as never,
    )
  })

  it('returns a PDF attachment for an owned invoice', async () => {
    mockedInvoiceFind.mockResolvedValue(baseInvoice as never)

    const res = await GET(makeGET(), makeParams(invoiceId))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="invoice-INV-100.pdf"',
    )
    expect(mockedRenderToStream).toHaveBeenCalledTimes(1)
    expect(mockedInvoiceFind).toHaveBeenCalledWith({
      where: { id: invoiceId },
      select: expect.objectContaining({ invoiceNumber: true, userId: true }),
    })
  })

  it('returns 401 when authorization is missing', async () => {
    const res = await GET(makeGET(invoiceId, false), makeParams(invoiceId))
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 401 when the auth token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)

    const res = await GET(makeGET(), makeParams(invoiceId))
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-UUID invoice id', async () => {
    const res = await GET(makeGET('not-a-uuid'), makeParams('not-a-uuid'))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields?.id).toBe('Must be a valid UUID')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist', async () => {
    mockedInvoiceFind.mockResolvedValue(null)

    const res = await GET(makeGET(), makeParams(invoiceId))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Invoice not found')
  })

  it('returns 404 when the invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({
      ...baseInvoice,
      userId: otherUserId,
    } as never)

    const res = await GET(makeGET(), makeParams(invoiceId))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Invoice not found')
    expect(mockedRenderToStream).not.toHaveBeenCalled()
  })

  it('returns 500 when PDF rendering fails', async () => {
    mockedInvoiceFind.mockResolvedValue(baseInvoice as never)
    mockedRenderToStream.mockRejectedValue(new Error('render failed'))

    const res = await GET(makeGET(), makeParams(invoiceId))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error.code).toBe('INTERNAL')
    expect(body.error.message).toBe('Failed to generate PDF')
  })
})
