import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    invoiceTag: { findUnique: vi.fn(), delete: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { DELETE } from '../[id]/tags/[tagId]/route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFindUnique = vi.mocked(prisma.invoice.findUnique)
const mockedInvoiceTagFindUnique = vi.mocked(prisma.invoiceTag.findUnique)
const mockedInvoiceTagDelete = vi.mocked(prisma.invoiceTag.delete)

const user = { id: 'user-1', privyId: 'privy-1' }

function makeRequest(authHeader = 'Bearer token'): NextRequest {
  return new NextRequest(
    'http://localhost/api/routes-d/invoices/inv-1/tags/tag-1',
    {
      method: 'DELETE',
      headers: authHeader ? { authorization: authHeader } : {},
    },
  )
}

const params = { params: Promise.resolve({ id: 'inv-1', tagId: 'tag-1' }) }

describe('DELETE /api/routes-d/invoices/[id]/tags/[tagId]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 401 without a verified bearer token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await DELETE(makeRequest(''), params)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the invoice does not exist', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(user as never)
    mockedInvoiceFindUnique.mockResolvedValue(null as never)
    const res = await DELETE(makeRequest(), params)
    expect(res.status).toBe(404)
  })

  it('returns 403 when the invoice belongs to a different user', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(user as never)
    mockedInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-2',
    } as never)
    const res = await DELETE(makeRequest(), params)
    expect(res.status).toBe(403)
  })

  it('returns 404 when the tag is not attached to the invoice', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(user as never)
    mockedInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: user.id,
    } as never)
    mockedInvoiceTagFindUnique.mockResolvedValue(null as never)
    const res = await DELETE(makeRequest(), params)
    expect(res.status).toBe(404)
    expect(mockedInvoiceTagDelete).not.toHaveBeenCalled()
  })

  it('deletes the join row and returns 204 on the happy path', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(user as never)
    mockedInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: user.id,
    } as never)
    mockedInvoiceTagFindUnique.mockResolvedValue({
      invoiceId: 'inv-1',
      tagId: 'tag-1',
    } as never)
    mockedInvoiceTagDelete.mockResolvedValue({} as never)

    const res = await DELETE(makeRequest(), params)
    expect(res.status).toBe(204)
    expect(mockedInvoiceTagDelete).toHaveBeenCalledWith({
      where: { invoiceId_tagId: { invoiceId: 'inv-1', tagId: 'tag-1' } },
    })
  })
})
