import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    creditNote: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const BASE_URL = 'http://localhost/api/credit-notes'

function makeGet(query = '', token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(`${BASE_URL}${query}`, { headers })
}

function makePost(body: unknown, token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = token
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const mockCreditNote = {
  id: 'cn-1',
  invoiceId: 'inv-1',
  creditNumber: 'CN-ABC123-XYZ789',
  amount: { toString: () => '50' },
  currency: 'USD',
  reason: 'Duplicate charge',
  status: 'issued',
  createdAt: new Date('2026-08-01'),
}

const mockInvoice = { id: 'inv-1', amount: { toString: () => '500' }, currency: 'USD' }

const mockCreated = {
  id: 'cn-new',
  invoiceId: 'inv-1',
  creditNumber: 'CN-NEW123-ABC456',
  amount: { toString: () => '50' },
  currency: 'USD',
  reason: 'Duplicate charge',
  status: 'issued',
  createdAt: new Date('2026-08-25'),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.creditNote.findMany).mockResolvedValue([mockCreditNote] as never)
  vi.mocked(prisma.creditNote.count).mockResolvedValue(1)
  vi.mocked(prisma.invoice.findFirst).mockResolvedValue(mockInvoice as never)
  vi.mocked(prisma.creditNote.create).mockResolvedValue(mockCreated as never)
})

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
describe('GET /api/credit-notes', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await GET(makeGet('', null))
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeGet())
    expect(res.status).toBe(401)
  })

  it('returns paginated credit notes on the happy path', async () => {
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.creditNotes).toHaveLength(1)
    expect(json.creditNotes[0].amount).toBe(50)
    expect(json.pagination).toEqual({ page: 1, limit: 25, total: 1, totalPages: 1 })
  })

  it('scopes the query to the authenticated user', async () => {
    await GET(makeGet())
    expect(prisma.creditNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    )
  })

  it('filters by status when provided', async () => {
    await GET(makeGet('?status=voided'))
    expect(prisma.creditNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'voided' }) }),
    )
  })

  it('returns 400 for an invalid status', async () => {
    const res = await GET(makeGet('?status=bogus'))
    expect(res.status).toBe(400)
  })

  it('clamps limit to MAX_LIMIT', async () => {
    const res = await GET(makeGet('?limit=9999'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.pagination.limit).toBe(100)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.creditNote.findMany).mockRejectedValue(new Error('db error') as never)
    const res = await GET(makeGet())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to fetch credit notes')
  })
})

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------
describe('POST /api/credit-notes', () => {
  const validBody = { invoiceId: 'inv-1', amount: 50, reason: 'Duplicate charge' }

  it('creates a credit note and returns 201', async () => {
    const res = await POST(makePost(validBody))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.creditNote.id).toBe('cn-new')
    expect(json.creditNote.amount).toBe(50)
    expect(json.creditNote.status).toBe('issued')
  })

  it('calls create with status=issued and correct userId/invoiceId', async () => {
    await POST(makePost(validBody))
    expect(prisma.creditNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          invoiceId: 'inv-1',
          amount: 50,
          reason: 'Duplicate charge',
          status: 'issued',
        }),
      }),
    )
  })

  it('generates a unique creditNumber', async () => {
    await POST(makePost(validBody))
    const call = vi.mocked(prisma.creditNote.create).mock.calls[0][0]
    expect(typeof (call.data as Record<string, unknown>).creditNumber).toBe('string')
    expect((call.data as Record<string, unknown>).creditNumber).toMatch(/^CN-/)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(makePost(validBody, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await POST(makePost('not-json'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Invalid JSON body')
  })

  it('returns 400 when invoiceId is missing', async () => {
    const res = await POST(makePost({ ...validBody, invoiceId: undefined }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when reason is missing', async () => {
    const res = await POST(makePost({ ...validBody, reason: undefined }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when amount is not positive', async () => {
    const res = await POST(makePost({ ...validBody, amount: -10 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when amount is zero', async () => {
    const res = await POST(makePost({ ...validBody, amount: 0 }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when invoiceId does not belong to the user', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
    const res = await POST(makePost(validBody))
    expect(res.status).toBe(404)
  })

  it('returns 400 when amount exceeds the invoice total', async () => {
    const res = await POST(makePost({ ...validBody, amount: 1000 }))
    expect(res.status).toBe(400)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.creditNote.create).mockRejectedValue(new Error('db error') as never)
    const res = await POST(makePost(validBody))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to create credit note')
  })
})
