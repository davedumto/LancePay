import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'

vi.mock('@/lib/db', () => ({
  prisma: {
    invoice: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
  extractRequestMetadata: vi.fn(() => ({})),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

const mockInvoice = {
  id: 'inv-1',
  invoiceNumber: 'INV-001',
  description: 'Test invoice',
  amount: 100,
  currency: 'USD',
  status: 'pending',
  dueDate: new Date(),
  user: { name: 'Test User', wallet: { address: 'G123' } },
}

function makeRequest(method: 'GET' | 'POST', body?: object) {
  const url = 'http://localhost/api/pay/INV-001'
  const options: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  }
  if (body) options.body = JSON.stringify(body)
  return new NextRequest(url, options)
}

describe('GET /api/pay/[invoiceId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(mockInvoice as any)
  })

  it('returns invoice details for valid invoice', async () => {
    const { GET } = await import('@/app/api/pay/[invoiceId]/route')
    const res = await GET(makeRequest('GET'), { params: Promise.resolve({ invoiceId: 'INV-001' }) })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.invoiceNumber).toBe('INV-001')
    expect(json.amount).toBe(100)
    expect(json.status).toBe('pending')
  })

  it('returns 404 for non-existent invoice', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(null)
    const { GET } = await import('@/app/api/pay/[invoiceId]/route')
    const res = await GET(makeRequest('GET'), { params: Promise.resolve({ invoiceId: 'INV-999' }) })
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toBe('Invoice not found')
  })
})

describe('POST /api/pay/[invoiceId] - removed', () => {
  it('POST handler is undefined since it was removed', async () => {
    const { POST } = await import('@/app/api/pay/[invoiceId]/route')
    expect(POST).toBeUndefined()
  })
})