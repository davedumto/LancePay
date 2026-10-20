import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    creditNote: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const BASE_URL = 'http://localhost/api/credit-notes'

function makeGet(id: string, token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(`${BASE_URL}/${id}`, { headers })
}

function callGet(id: string, token?: string | null) {
  return GET(makeGet(id, token), { params: Promise.resolve({ id }) })
}

const mockCreditNote = {
  id: 'cn-1',
  userId: 'user-1',
  invoiceId: 'inv-1',
  creditNumber: 'CN-ABC123-XYZ789',
  amount: { toString: () => '100' },
  currency: 'USD',
  reason: 'Duplicate charge',
  status: 'issued',
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.creditNote.findUnique).mockResolvedValue(mockCreditNote as never)
})

describe('GET /api/credit-notes/[id]', () => {
  it('returns the credit note on the happy path', async () => {
    const res = await callGet('cn-1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.creditNote.id).toBe('cn-1')
    expect(json.creditNote.creditNumber).toBe('CN-ABC123-XYZ789')
    expect(json.creditNote.status).toBe('issued')
  })

  it('includes amount as a number', async () => {
    const res = await callGet('cn-1')
    const json = await res.json()
    expect(json.creditNote.amount).toBe(100)
  })

  it('computes remainingBalance as amount minus appliedAmount', async () => {
    const res = await callGet('cn-1')
    const json = await res.json()
    expect(json.creditNote.appliedAmount).toBe(0)
    expect(json.creditNote.remainingBalance).toBe(100)
  })

  it('includes an applications array', async () => {
    const res = await callGet('cn-1')
    const json = await res.json()
    expect(Array.isArray(json.creditNote.applications)).toBe(true)
  })

  it('returns ISO string timestamps', async () => {
    const res = await callGet('cn-1')
    const json = await res.json()
    expect(json.creditNote.createdAt).toBe('2026-08-01T00:00:00.000Z')
    expect(typeof json.creditNote.updatedAt).toBe('string')
  })

  it('returns 401 when no token is provided', async () => {
    const res = await callGet('cn-1', null)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await callGet('cn-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 when the credit note does not exist', async () => {
    vi.mocked(prisma.creditNote.findUnique).mockResolvedValue(null)
    const res = await callGet('missing')
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Credit note not found')
  })

  it('returns 403 when the credit note belongs to another user', async () => {
    vi.mocked(prisma.creditNote.findUnique).mockResolvedValue({
      ...mockCreditNote,
      userId: 'someone-else',
    } as never)
    const res = await callGet('cn-1')
    expect(res.status).toBe(403)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.creditNote.findUnique).mockRejectedValue(new Error('db error') as never)
    const res = await callGet('cn-1')
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to fetch credit note')
  })
})
