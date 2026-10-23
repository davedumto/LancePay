import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    invoicePublicLink: { findFirst: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/crypto', () => ({
  generateToken: vi.fn(() => 'test-token-12345678'),
  hashToken: vi.fn(() => 'hashed-token-123'),
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'
const mockInvoiceId = 'invoice-123'
const params = { id: mockInvoiceId }

function makeRequest(method: 'GET' | 'POST', body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3000/api/invoices/${mockInvoiceId}/public-link`, {
    method,
    headers: { Authorization: 'Bearer valid-token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as { userId: string })
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
  vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: mockInvoiceId } as never)
})

describe('GET /api/invoices/[id]/public-link', () => {
  it('returns the public link for the authenticated owner', async () => {
    const mockPublicLink = {
      id: 'link-1',
      tokenHint: '12345678',
      lastViewedAt: new Date(),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.invoicePublicLink.findFirst).mockResolvedValue(mockPublicLink as never)

    const res = await GET(makeRequest('GET'), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.publicLink.id).toBe('link-1')
    expect(data.publicLink.status).toBe('active')
  })

  it('returns 404 when public link does not exist', async () => {
    vi.mocked(prisma.invoicePublicLink.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(404)
  })

  it('returns 404 when invoice does not exist', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(404)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/invoices/${mockInvoiceId}/public-link`)
    const res = await GET(request, { params })
    expect(res.status).toBe(401)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.invoicePublicLink.findFirst).mockRejectedValue(new Error('Database error'))
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(500)
  })
})

describe('POST /api/invoices/[id]/public-link', () => {
  it('creates a public link and returns the raw token', async () => {
    const mockPublicLink = {
      id: 'link-1',
      tokenHint: '12345678',
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.invoicePublicLink.create).mockResolvedValue(mockPublicLink as never)

    const res = await POST(makeRequest('POST'), { params })
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.publicLink.token).toBe('test-token-12345678')
    expect(data.publicLink.tokenHint).toBe('12345678')
    expect(prisma.invoicePublicLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        invoiceId: mockInvoiceId,
        hashedToken: 'hashed-token-123',
        tokenHint: '12345678',
        createdBy: mockUserId,
      }),
      select: expect.any(Object),
    })
  })

  it('uses default expiration when not provided', async () => {
    const mockPublicLink = {
      id: 'link-1',
      tokenHint: '12345678',
      expiresAt: new Date(Date.now() + 2592000000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.invoicePublicLink.create).mockResolvedValue(mockPublicLink as never)

    const res = await POST(makeRequest('POST'), { params })
    expect(res.status).toBe(201)
  })

  it('uses custom expiration when provided', async () => {
    const mockPublicLink = {
      id: 'link-1',
      tokenHint: '12345678',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.invoicePublicLink.create).mockResolvedValue(mockPublicLink as never)

    const res = await POST(makeRequest('POST', { expiresInSeconds: 3600 }), { params })
    expect(res.status).toBe(201)
  })

  it('rejects expiresInSeconds greater than max', async () => {
    const res = await POST(makeRequest('POST', { expiresInSeconds: 999999999 }), { params })
    expect(res.status).toBe(400)
  })

  it('rejects non-positive expiresInSeconds', async () => {
    const res = await POST(makeRequest('POST', { expiresInSeconds: -1 }), { params })
    expect(res.status).toBe(400)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/invoices/${mockInvoiceId}/public-link`, {
      method: 'POST',
    })
    const res = await POST(request, { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice does not exist', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
    const res = await POST(makeRequest('POST'), { params })
    expect(res.status).toBe(404)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.invoicePublicLink.create).mockRejectedValue(new Error('Database error'))
    const res = await POST(makeRequest('POST'), { params })
    expect(res.status).toBe(500)
  })
})
