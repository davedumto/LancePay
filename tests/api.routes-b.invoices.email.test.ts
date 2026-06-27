import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const invoiceFindFirst = vi.fn()
const sendInvoiceToClient = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    invoice: { findFirst: invoiceFindFirst },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/email', () => ({ sendInvoiceToClient }))

const URL = 'http://localhost/api/routes-b/invoices/inv-1/email'

function req(token: string | null = 'tok') {
  const h = new Headers()
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'POST', headers: h })
}

describe('POST /api/routes-b/invoices/[id]/email', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with invalid token', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/email/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/email/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 422 for invalid client email', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1', name: 'User One' })
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-1',
      clientEmail: 'bademail',
      invoiceNumber: '001',
      amount: 100,
      currency: 'USD',
      dueDate: null,
      paymentLink: 'link',
    })
    sendInvoiceToClient.mockResolvedValue({ success: false, skipped: true })

    const { POST } = await import('@/app/api/routes-b/invoices/[id]/email/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toBe('Invalid client email')
  })

  it('returns 500 when email fails', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1', name: 'User One' })
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-1',
      clientEmail: 'client@example.com',
      invoiceNumber: '001',
      amount: 100,
      currency: 'USD',
      dueDate: null,
      paymentLink: 'link',
    })
    sendInvoiceToClient.mockRejectedValue(new Error('Send failed'))

    const { POST } = await import('@/app/api/routes-b/invoices/[id]/email/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to send email')
  })

  it('returns 200 on successful email send', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1', name: 'User One' })
    invoiceFindFirst.mockResolvedValue({
      id: 'inv-1',
      clientEmail: 'client@example.com',
      invoiceNumber: '001',
      amount: 100,
      currency: 'USD',
      dueDate: new Date('2025-01-01T00:00:00.000Z'),
      paymentLink: 'link',
    })
    sendInvoiceToClient.mockResolvedValue({ success: true })
    
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/email/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'inv-1' }) })
    
    expect(res.status).toBe(200)
    expect(sendInvoiceToClient).toHaveBeenCalledWith({
      clientEmail: 'client@example.com',
      clientName: undefined,
      freelancerName: 'User One',
      invoiceNumber: '001',
      amount: 100,
      currency: 'USD',
      dueDate: '2025-01-01T00:00:00.000Z',
      paymentLink: 'link',
    })
    
    const json = await res.json()
    expect(json.id).toBe('inv-1')
    expect(json.emailSent).toBe(true)
  })
})
