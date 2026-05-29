import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: vi.fn() }, invoice: { findMany: vi.fn() } },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFindMany = vi.mocked(prisma.invoice.findMany)

function reqGET(query = '', auth = 'Bearer token'): NextRequest {
  return new NextRequest(`http://localhost/api/routes-d/search${query}`, {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

describe('GET /api/routes-d/search', () => {
  it('returns 401 without token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(reqGET('?q=test', ''))).status).toBe(401)
  })

  it('returns 404 if user not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(reqGET('?q=test'))).status).toBe(404)
  })

  it('returns 400 if q is missing or too short', async () => {
    expect((await GET(reqGET('?q=t'))).status).toBe(400)
    expect((await GET(reqGET(''))).status).toBe(400)
  })

  it('returns both invoices and contacts when no type specified', async () => {
    mockedInvoiceFindMany.mockResolvedValueOnce([{ id: 'inv-1', invoiceNumber: '001' }] as never)
    mockedInvoiceFindMany.mockResolvedValueOnce([{ clientName: 'John', clientEmail: 'john@example.com' }] as never)

    const res = await GET(reqGET('?q=john'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.results.invoices).toHaveLength(1)
    expect(json.results.contacts).toHaveLength(1)
    expect(json.totalResults).toBe(2)
  })

  it('returns only invoices when type=invoices', async () => {
    mockedInvoiceFindMany.mockResolvedValueOnce([{ id: 'inv-1', invoiceNumber: '001' }] as never)

    const res = await GET(reqGET('?q=john&type=invoices'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.results.invoices).toHaveLength(1)
    expect(json.results.contacts).toHaveLength(0)
    expect(json.totalResults).toBe(1)
  })

  it('returns only contacts when type=contacts', async () => {
    mockedInvoiceFindMany.mockResolvedValueOnce([{ clientName: 'John', clientEmail: 'john@example.com' }] as never)

    const res = await GET(reqGET('?q=john&type=contacts'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.results.invoices).toHaveLength(0)
    expect(json.results.contacts).toHaveLength(1)
    expect(json.totalResults).toBe(1)
  })

  it('accepts single character in typeahead mode', async () => {
    mockedInvoiceFindMany.mockResolvedValueOnce([{ invoiceNumber: '001' }] as never)
    mockedInvoiceFindMany.mockResolvedValueOnce([{ clientName: 'John' }] as never)
    mockedInvoiceFindMany.mockResolvedValueOnce([{ clientEmail: 'john@example.com' }] as never)

    const res = await GET(reqGET('?q=j&typeahead=true'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.typeahead).toBe(true)
    expect(json.suggestions).toBeDefined()
    expect(Array.isArray(json.suggestions)).toBe(true)
  })

  it('rejects single character in normal search mode', async () => {
    const res = await GET(reqGET('?q=j'))
    expect(res.status).toBe(400)
  })

  it('returns ranked typeahead suggestions with 5 per category', async () => {
    mockedInvoiceFindMany.mockResolvedValueOnce([
      { invoiceNumber: 'INV-001' },
      { invoiceNumber: 'INV-002' },
    ] as never)
    mockedInvoiceFindMany.mockResolvedValueOnce([
      { clientName: 'Acme Corp' },
      { clientName: 'Apex Inc' },
    ] as never)
    mockedInvoiceFindMany.mockResolvedValueOnce([
      { clientEmail: 'acme@example.com' },
      { clientEmail: 'apex@example.com' },
    ] as never)

    const res = await GET(reqGET('?q=a&typeahead=true'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.suggestions).toHaveLength(6)
    expect(json.suggestions).toContain('INV-001')
    expect(json.suggestions).toContain('Acme Corp')
    expect(json.suggestions).toContain('acme@example.com')
  })
})
