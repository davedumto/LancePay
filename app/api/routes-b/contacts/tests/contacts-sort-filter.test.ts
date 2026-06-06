import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '../route'
import { buildRequest } from '../../../_lib/test-helpers'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    contact: { findMany: vi.fn() },
    invoice: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    $queryRawUnsafe: vi.fn(),
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('../../../_lib/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/contacts')>()
  return { ...actual }
})

vi.mock('../../../_lib/flags', () => ({
  ENABLE_CONTACTS_SOFT_DELETE: false,
}))

vi.mock('../../../_lib/table-columns', () => ({
  hasTableColumn: vi.fn().mockResolvedValue(false),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockedFindUnique = vi.mocked(prisma.user.findUnique)
const mockedContactFindMany = vi.mocked(prisma.contact.findMany)
const mockedInvoiceFindMany = vi.mocked(prisma.invoice.findMany)
const mockedInvoiceGroupBy = vi.mocked(prisma.invoice.groupBy)
const mockedVerifyAuthToken = vi.mocked(verifyAuthToken)

const fakeUser = { id: 'user-1', role: 'freelancer' }

function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    name: 'Alice',
    email: 'alice@ex.com',
    company: null,
    notes: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  }
}

describe('GET /api/routes-b/contacts', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as any)
    mockedFindUnique.mockResolvedValue(fakeUser as any)
    mockedInvoiceFindMany.mockResolvedValue([])
    mockedInvoiceGroupBy.mockResolvedValue([])
  })

  function req(params = '') {
    return buildRequest('GET', `http://localhost/api/routes-b/contacts${params}`, { token: 'tok' })
  }

  it('defaults to createdAt desc when no params given', async () => {
    mockedContactFindMany.mockResolvedValue([makeContact()])
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.contacts).toHaveLength(1)
    // Verify orderBy was called with createdAt desc
    expect(mockedContactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    )
  })

  it('sorts by name asc', async () => {
    mockedContactFindMany.mockResolvedValue([makeContact()])
    await GET(req('?sort=name&order=asc'))
    expect(mockedContactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } }),
    )
  })

  it('sorts by name desc', async () => {
    mockedContactFindMany.mockResolvedValue([makeContact()])
    await GET(req('?sort=name&order=desc'))
    expect(mockedContactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'desc' } }),
    )
  })

  it('sorts by createdAt asc', async () => {
    mockedContactFindMany.mockResolvedValue([makeContact()])
    await GET(req('?sort=createdAt&order=asc'))
    expect(mockedContactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'asc' } }),
    )
  })

  it('sorts by lastUsed (returns sorted contacts)', async () => {
    const older = makeContact({ id: 'c-1', email: 'older@ex.com', createdAt: new Date('2026-01-01') })
    const newer = makeContact({ id: 'c-2', email: 'newer@ex.com', createdAt: new Date('2026-03-01') })
    mockedContactFindMany.mockResolvedValue([older, newer])
    mockedInvoiceGroupBy.mockResolvedValue([
      { clientEmail: 'older@ex.com', _max: { createdAt: new Date('2026-01-15') } },
      { clientEmail: 'newer@ex.com', _max: { createdAt: new Date('2026-03-15') } },
    ] as any)

    const res = await GET(req('?sort=lastUsed&order=desc'))
    const body = await res.json()
    expect(body.contacts[0].email).toBe('newer@ex.com')
    expect(body.contacts[1].email).toBe('older@ex.com')
  })

  it('filters by tag', async () => {
    mockedInvoiceFindMany.mockResolvedValue([{ clientEmail: 'alice@ex.com' }] as any)
    mockedContactFindMany.mockResolvedValue([makeContact()])

    const res = await GET(req('?tag=important'))
    expect(res.status).toBe(200)
    // contact.findMany should have been called with email filter
    expect(mockedContactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ email: { in: ['alice@ex.com'] } }),
      }),
    )
  })

  it('filters by q (substring)', async () => {
    mockedContactFindMany.mockResolvedValue([makeContact()])
    await GET(req('?q=alice'))
    expect(mockedContactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { name: { contains: 'alice', mode: 'insensitive' } },
            { email: { contains: 'alice', mode: 'insensitive' } },
          ],
        }),
      }),
    )
  })

  it('rejects unknown sort field with 400', async () => {
    const res = await GET(req('?sort=invalid'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invalid sort field/i)
  })

  it('combines tag and q filters (AND semantics)', async () => {
    mockedInvoiceFindMany.mockResolvedValue([{ clientEmail: 'alice@ex.com' }] as any)
    mockedContactFindMany.mockResolvedValue([makeContact()])

    await GET(req('?tag=vip&q=alice'))
    expect(mockedContactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: { in: ['alice@ex.com'] },
          OR: [
            { name: { contains: 'alice', mode: 'insensitive' } },
            { email: { contains: 'alice', mode: 'insensitive' } },
          ],
        }),
      }),
    )
  })
})
