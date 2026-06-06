import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

// ── Mocks ──

vi.mock('../../_lib/with-request-id', () => ({
  withRequestId: (handler: any) => handler,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    invoice: {
      findMany: vi.fn(),
    },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('../../_lib/invoice-archive', () => ({
  getArchiveFilter: vi.fn((includeArchived: boolean) =>
    includeArchived ? {} : { archivedAt: null },
  ),
  parseIncludeArchivedParam: vi.fn((val: string | null) => val === 'true'),
}))

vi.mock('../../_lib/cursor', () => ({
  encodeCursor: vi.fn((payload: any) => Buffer.from(JSON.stringify(payload)).toString('base64url')),
  decodeCursor: vi.fn((cursor: string) => {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (parsed.createdAt && parsed.id) return parsed
      return null
    } catch {
      return null
    }
  }),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { decodeCursor } from '../../_lib/cursor'

// ── Helpers ──

function makeRequest(opts: {
  token?: string
  limit?: string
  cursor?: string
  includeArchived?: string
} = {}): NextRequest {
  const url = new URL('http://localhost/api/routes-b/invoices/pending')
  if (opts.limit) url.searchParams.set('limit', opts.limit)
  if (opts.cursor) url.searchParams.set('cursor', opts.cursor)
  if (opts.includeArchived) url.searchParams.set('includeArchived', opts.includeArchived)

  const headers = new Headers()
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`)

  return new NextRequest(url.toString(), { headers })
}

function mockUser(id: string, privyId: string) {
  (prisma.user.findUnique as any).mockResolvedValue({ id, privyId })
}

function mockInvoices(invoices: any[]) {
  (prisma.invoice.findMany as any).mockResolvedValue(invoices)
}

function mockAuth(userId: string | null) {
  (verifyAuthToken as any).mockResolvedValue(userId ? { userId } : null)
}

// ── Tests ──

describe('GET /api/routes-b/invoices/pending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Happy path ──

  it('returns pending invoices for authenticated user', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')
    mockInvoices([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-001',
        clientName: 'Acme Corp',
        amount: 50000n,
        dueDate: new Date('2024-12-31'),
        createdAt: new Date('2024-01-15'),
        status: 'pending',
        archivedAt: null,
      },
      {
        id: 'inv-2',
        invoiceNumber: 'INV-002',
        clientName: 'Globex',
        amount: 75000n,
        dueDate: new Date('2024-11-30'),
        createdAt: new Date('2024-01-10'),
        status: 'pending',
        archivedAt: null,
      },
    ])

    const req = makeRequest({ token: 'valid-token' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoices).toHaveLength(2)
    expect(body.invoices[0].amount).toBe(50000)
    expect(body.invoices[0].invoiceNumber).toBe('INV-001')
    expect(body.nextCursor).toBeNull()
  })

  it('returns paginated results with nextCursor', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')

    const invoices = Array.from({ length: 26 }, (_, i) => ({
      id: `inv-${i}`,
      invoiceNumber: `INV-${String(i).padStart(3, '0')}`,
      clientName: `Client ${i}`,
      amount: BigInt(1000 * (i + 1)),
      dueDate: new Date('2024-12-31'),
      createdAt: new Date(Date.now() - i * 86400000),
      status: 'pending',
      archivedAt: null,
    }))

    mockInvoices(invoices)

    const req = makeRequest({ token: 'valid-token', limit: '25' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoices).toHaveLength(25)
    expect(body.nextCursor).not.toBeNull()
    expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('uses cursor for pagination', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')

    const cursorPayload = { createdAt: new Date().toISOString(), id: 'inv-25' }
    const cursor = Buffer.from(JSON.stringify(cursorPayload)).toString('base64url')

    mockInvoices([
      {
        id: 'inv-26',
        invoiceNumber: 'INV-026',
        clientName: 'Later Client',
        amount: 26000n,
        dueDate: new Date('2024-12-31'),
        createdAt: new Date(Date.now() - 26 * 86400000),
        status: 'pending',
        archivedAt: null,
      },
    ])

    const req = makeRequest({ token: 'valid-token', cursor })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoices).toHaveLength(1)
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.any(Array),
        }),
      }),
    )
  })

  it('includes archived invoices when includeArchived=true', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')
    mockInvoices([
      {
        id: 'inv-archived',
        invoiceNumber: 'INV-ARC',
        clientName: 'Archived Client',
        amount: 10000n,
        dueDate: new Date('2024-12-31'),
        createdAt: new Date('2024-01-01'),
        status: 'pending',
        archivedAt: new Date('2024-06-01'),
      },
    ])

    const req = makeRequest({ token: 'valid-token', includeArchived: 'true' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoices).toHaveLength(1)
  })

  it('respects custom limit parameter', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')
    mockInvoices([])

    const req = makeRequest({ token: 'valid-token', limit: '10' })
    await GET(req)

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11 }),
    )
  })

  // ── Auth failure modes ──

  it('returns 401 when authorization header is missing', async () => {
    const req = makeRequest()
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toContain('Missing Authorization header')
  })

  it('returns 401 when Bearer token is empty', async () => {
    const req = makeRequest({ token: '' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toContain('Empty Bearer token')
  })

  it('returns 401 when token is invalid', async () => {
    mockAuth(null)
    const req = makeRequest({ token: 'invalid-token' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toContain('Invalid or expired token')
  })

  // ── Ownership failure modes ──

  it('returns 404 when user does not exist', async () => {
    mockAuth('privy-ghost')
    ;(prisma.user.findUnique as any).mockResolvedValue(null)

    const req = makeRequest({ token: 'valid-token' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('USER_NOT_FOUND')
  })

  // ── Validation failure modes ──

  it('returns 400 when limit exceeds maximum', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')

    const req = makeRequest({ token: 'valid-token', limit: '200' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toContain('limit')
  })

  it('returns 400 when limit is zero', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')

    const req = makeRequest({ token: 'valid-token', limit: '0' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when limit is negative', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')

    const req = makeRequest({ token: 'valid-token', limit: '-5' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when cursor is malformed', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')

    const req = makeRequest({ token: 'valid-token', cursor: 'not-valid-cursor' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('INVALID_CURSOR')
    expect(body.error.message).toContain('Malformed')
  })

  it('returns 400 when cursor payload is missing required fields', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')
    ;(decodeCursor as any).mockReturnValue(null)

    const badCursor = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url')
    const req = makeRequest({ token: 'valid-token', cursor: badCursor })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('INVALID_CURSOR')
  })

  // ── Edge cases ──

  it('returns empty array when no pending invoices exist', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')
    mockInvoices([])

    const req = makeRequest({ token: 'valid-token' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoices).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  it('serializes BigInt amount as number in response', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')
    mockInvoices([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-001',
        clientName: 'Test',
        amount: 999999999999n,
        dueDate: new Date('2024-12-31'),
        createdAt: new Date('2024-01-01'),
        status: 'pending',
        archivedAt: null,
      },
    ])

    const req = makeRequest({ token: 'valid-token' })
    const res = await GET(req)
    const body = await res.json()

    expect(typeof body.invoices[0].amount).toBe('number')
    expect(body.invoices[0].amount).toBe(999999999999)
  })

  it('defaults limit to 25 when not provided', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')
    mockInvoices([])

    const req = makeRequest({ token: 'valid-token' })
    await GET(req)

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 26 }),
    )
  })

  it('filters by userId to enforce ownership', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')
    mockInvoices([])

    const req = makeRequest({ token: 'valid-token' })
    await GET(req)

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-123' }),
      }),
    )
  })

  it('filters by pending status only', async () => {
    mockAuth('privy-123')
    mockUser('user-123', 'privy-123')
    mockInvoices([])

    const req = makeRequest({ token: 'valid-token' })
    await GET(req)

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'pending' }),
      }),
    )
  })
})