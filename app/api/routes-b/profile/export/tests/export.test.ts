import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { acquireExportLock, releaseExportLock, resetExportLocks } from '../../../_lib/export-limiter'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn() },
    contact: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() },
    auditEvent: { findMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockVerify = vi.mocked(verifyAuthToken)
const mockUserFind = vi.mocked(prisma.user.findUnique)

const fakeUser = {
  id: 'user-1',
  privyId: 'privy-1',
  email: 'user@example.com',
  name: 'Test User',
  phone: null,
  createdAt: new Date('2024-01-01'),
}

function makeReq(token = 'tok'): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/profile/export', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
}

async function collectStream(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return new TextDecoder().decode(
    chunks.reduce((acc, chunk) => {
      const merged = new Uint8Array(acc.length + chunk.length)
      merged.set(acc)
      merged.set(chunk, acc.length)
      return merged
    }, new Uint8Array()),
  )
}

describe('POST /profile/export', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetExportLocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as any)
    mockUserFind.mockResolvedValue(fakeUser as any)
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([])
    vi.mocked(prisma.contact.findMany).mockResolvedValue([])
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([])
    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([])
  })

  it('returns 401 when no token', async () => {
    const req = new NextRequest('http://localhost/api/routes-b/profile/export', { method: 'POST' })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    mockVerify.mockResolvedValue(null)
    const res = await POST(makeReq())
    expect(res.status).toBe(401)
  })

  it('sets Content-Type to application/x-ndjson', async () => {
    const res = await POST(makeReq())
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
  })

  it('streams profile section for empty user', async () => {
    const res = await POST(makeReq())
    expect(res.status).toBe(200)
    const text = await collectStream(res)
    const lines = text.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const profile = JSON.parse(lines[0])
    expect(profile._section).toBe('profile')
    expect(profile.email).toBe('user@example.com')
  })

  it('streams all sections including invoices and contacts for populated user', async () => {
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([
      { id: 'inv-1', invoiceNumber: 'INV-001', clientEmail: 'c@c.com', clientName: 'Client', amount: 100, currency: 'USD', status: 'paid', dueDate: null, paidAt: null, createdAt: new Date() },
    ] as any)
    vi.mocked(prisma.contact.findMany).mockResolvedValue([
      { id: 'cnt-1', name: 'Alice', email: 'alice@example.com', company: null, createdAt: new Date() },
    ] as any)

    const res = await POST(makeReq())
    const text = await collectStream(res)
    const lines = text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))

    const sections = lines.map((l: any) => l._section)
    expect(sections).toContain('profile')
    expect(sections).toContain('invoice')
    expect(sections).toContain('contact')
  })

  it('returns 429 when a concurrent export is already in progress', async () => {
    // Manually hold the lock to simulate an in-progress export
    acquireExportLock('user-1')
    try {
      const res = await POST(makeReq())
      expect(res.status).toBe(429)
      const body = await res.json()
      expect(body.error).toMatch(/already in progress/i)
    } finally {
      releaseExportLock('user-1')
    }
  })

  it('releases lock after stream ends, allowing subsequent exports', async () => {
    const res1 = await POST(makeReq())
    await collectStream(res1) // consume stream → releases lock

    const res2 = await POST(makeReq())
    expect(res2.status).toBe(200)
  })
})
