import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '@/app/api/time-entries/convert-to-invoice/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    timeEntry: { findMany: vi.fn(), updateMany: vi.fn() },
    invoice: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  generateInvoiceNumber: vi.fn(),
}))

const mockUser = { id: 'user-1', email: 'freelancer@example.com' }

const ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function makeRequest(body: object, token = 'Bearer valid-token') {
  return new Request('http://localhost/api/time-entries/convert-to-invoice', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

const txInvoiceCreate = vi.fn()
const txUpdateMany = vi.fn()

describe('POST /api/time-entries/convert-to-invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
    vi.mocked(generateInvoiceNumber).mockReturnValue('INV-900')
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com'

    txInvoiceCreate.mockResolvedValue({
      id: 'inv-1',
      invoiceNumber: 'INV-900',
      paymentLink: 'https://example.com/pay/INV-900',
      status: 'pending',
      amount: 250,
      currency: 'USD',
    })
    txUpdateMany.mockResolvedValue({ count: 2 })

    vi.mocked(prisma.$transaction).mockImplementation(
      // Execute the callback with a stubbed transactional client.
      async (cb: never) =>
        (cb as unknown as (tx: unknown) => Promise<unknown>)({
          invoice: { create: txInvoiceCreate },
          timeEntry: { updateMany: txUpdateMany },
        }),
    )
  })

  const validBody = {
    timeEntryIds: [ID_A, ID_B],
    clientEmail: 'client@example.com',
  }

  it('converts unbilled entries into an invoice and marks them billed', async () => {
    vi.mocked(prisma.timeEntry.findMany).mockResolvedValue([
      { id: ID_A, hours: 2, rateUsdc: 50, status: 'draft', invoiceId: null, project: { id: 'p1', title: 'Alpha' } },
      { id: ID_B, hours: 3, rateUsdc: 50, status: 'draft', invoiceId: null, project: { id: 'p1', title: 'Alpha' } },
    ] as never)

    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.invoiceNumber).toBe('INV-900')
    expect(json.convertedEntryCount).toBe(2)
    // Same project + rate collapses into one line item.
    expect(json.lineItemCount).toBe(1)

    // Invoice total: (2 + 3) hours * 50 = 250.
    expect(txInvoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 250 }) }),
    )
    expect(txUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'billed', invoiceId: 'inv-1' },
      }),
    )
  })

  it('rejects entries already marked billed to prevent double-billing', async () => {
    vi.mocked(prisma.timeEntry.findMany).mockResolvedValue([
      { id: ID_A, hours: 2, rateUsdc: 50, status: 'billed', invoiceId: null, project: null },
      { id: ID_B, hours: 3, rateUsdc: 50, status: 'draft', invoiceId: null, project: null },
    ] as never)

    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(409)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects entries already linked to an invoice', async () => {
    vi.mocked(prisma.timeEntry.findMany).mockResolvedValue([
      { id: ID_A, hours: 2, rateUsdc: 50, status: 'draft', invoiceId: 'inv-old', project: null },
      { id: ID_B, hours: 3, rateUsdc: 50, status: 'draft', invoiceId: null, project: null },
    ] as never)

    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(409)
  })

  it('returns 404 when an entry is missing or not owned', async () => {
    vi.mocked(prisma.timeEntry.findMany).mockResolvedValue([
      { id: ID_A, hours: 2, rateUsdc: 50, status: 'draft', invoiceId: null, project: null },
    ] as never)

    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(404)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('groups entries into separate line items per project and rate', async () => {
    vi.mocked(prisma.timeEntry.findMany).mockResolvedValue([
      { id: ID_A, hours: 2, rateUsdc: 50, status: 'draft', invoiceId: null, project: { id: 'p1', title: 'Alpha' } },
      { id: ID_B, hours: 4, rateUsdc: 75, status: 'draft', invoiceId: null, project: { id: 'p2', title: 'Beta' } },
    ] as never)

    const res = await POST(makeRequest(validBody))
    const json = await res.json()
    expect(json.lineItemCount).toBe(2)
    // 2*50 + 4*75 = 400
    expect(txInvoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 400 }) }),
    )
  })

  it('rejects an empty timeEntryIds list', async () => {
    const res = await POST(makeRequest({ timeEntryIds: [], clientEmail: 'client@example.com' }))
    expect(res.status).toBe(400)
  })

  it('rejects an unauthenticated request', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(401)
  })
})
