import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'
import { resetSuggestCache } from '../_lib/cache'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn() },
    contact: { findMany: vi.fn() },
    tag: { findMany: vi.fn() },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFindMany = vi.mocked(prisma.invoice.findMany)
const mockedContactFindMany = vi.mocked(prisma.contact.findMany)
const mockedTagFindMany = vi.mocked(prisma.tag.findMany)

function makeRequest(q: string) {
  return new NextRequest(`http://localhost/api/routes-b/search/suggest?q=${encodeURIComponent(q)}`, {
    headers: { authorization: 'Bearer token' },
  })
}

describe('GET /api/routes-b/search/suggest', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetSuggestCache()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user-1' } as never)
    mockedInvoiceFindMany.mockResolvedValue([] as never)
    mockedContactFindMany.mockResolvedValue([] as never)
    mockedTagFindMany.mockResolvedValue([] as never)
  })

  it('rejects short query', async () => {
    const res = await GET(makeRequest('a'))
    expect(res.status).toBe(400)
  })

  it('returns cross-type suggestions ordered by recency', async () => {
    mockedInvoiceFindMany.mockResolvedValue([
      { id: 'inv-1', invoiceNumber: 'INV-100', clientName: 'Acme', createdAt: new Date('2026-01-02') },
    ] as never)
    mockedContactFindMany.mockResolvedValue([
      { id: 'con-1', name: 'Acme Corp', createdAt: new Date('2026-01-03') },
    ] as never)
    mockedTagFindMany.mockResolvedValue([
      { id: 'tag-1', name: 'acme', createdAt: new Date('2026-01-01') },
    ] as never)

    const res = await GET(makeRequest('acme'))
    expect(res.status).toBe(200)
    const json = await res.json()

    expect(json.cache).toBe('miss')
    expect(json.suggestions.map((s: { type: string }) => s.type)).toEqual(['contact', 'invoice', 'tag'])
    expect(json.suggestions).toHaveLength(3)
  })

  it('returns cached value on repeated query', async () => {
    mockedInvoiceFindMany.mockResolvedValue([
      { id: 'inv-1', invoiceNumber: 'INV-100', clientName: 'Acme', createdAt: new Date('2026-01-02') },
    ] as never)

    const first = await GET(makeRequest('acme'))
    expect(first.status).toBe(200)
    expect((await first.json()).cache).toBe('miss')

    const second = await GET(makeRequest('acme'))
    expect(second.status).toBe(200)
    expect((await second.json()).cache).toBe('hit')
    expect(mockedInvoiceFindMany).toHaveBeenCalledTimes(1)
  })
})
