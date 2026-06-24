import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn(), count: vi.fn().mockResolvedValue(0), groupBy: vi.fn().mockResolvedValue([]) },
    bankAccount: { findMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    contact: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    tag: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
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
const mockedBankFindMany = vi.mocked(prisma.bankAccount.findMany)

function makeRequest(q: string) {
  return new NextRequest(`http://localhost/api/routes-b/search?q=${encodeURIComponent(q)}`, {
    headers: { authorization: 'Bearer token' },
  })
}

describe('GET /api/routes-b/search validation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user-1' } as never)
    mockedInvoiceFindMany.mockResolvedValue([] as never)
    mockedBankFindMany.mockResolvedValue([] as never)
    vi.mocked(prisma.contact.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.tag.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.invoice.count).mockResolvedValue(0 as never)
    vi.mocked(prisma.bankAccount.count).mockResolvedValue(0 as never)
    vi.mocked(prisma.contact.count).mockResolvedValue(0 as never)
    vi.mocked(prisma.tag.count).mockResolvedValue(0 as never)
    vi.mocked(prisma.invoice.groupBy).mockResolvedValue([] as never)
  })

  it('rejects an empty query without calling search tables', async () => {
    const res = await GET(makeRequest(''))

    expect(res.status).toBe(400)
    expect(mockedInvoiceFindMany).not.toHaveBeenCalled()
    expect(mockedBankFindMany).not.toHaveBeenCalled()
  })

  it('rejects a one-character query without calling search tables', async () => {
    const res = await GET(makeRequest('a'))

    expect(res.status).toBe(400)
    expect(mockedInvoiceFindMany).not.toHaveBeenCalled()
    expect(mockedBankFindMany).not.toHaveBeenCalled()
  })

  it('trims leading and trailing whitespace before searching', async () => {
    const res = await GET(makeRequest('  acme  '))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.query).toBe('acme')
    expect(mockedInvoiceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { invoiceNumber: { contains: 'acme', mode: 'insensitive' } },
          ]),
        }),
      }),
    )
  })

  it('strips SQL wildcard characters before searching', async () => {
    await GET(makeRequest('%a_c%'))

    expect(mockedInvoiceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { invoiceNumber: { contains: 'ac', mode: 'insensitive' } },
          ]),
        }),
      }),
    )
  })

  it('caps oversized queries at 128 characters', async () => {
    await GET(makeRequest('a'.repeat(200)))

    expect(mockedInvoiceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { invoiceNumber: { contains: 'a'.repeat(128), mode: 'insensitive' } },
          ]),
        }),
      }),
    )
  })
})
