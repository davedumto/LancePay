import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockInvoiceFindUnique = vi.fn()
const mockTagFindUnique = vi.fn()
const mockTagDelete = vi.fn()
const mockInvoiceTagFindUnique = vi.fn()
const mockInvoiceTagFindMany = vi.fn()
const mockInvoiceTagCreate = vi.fn()
const mockInvoiceTagDelete = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    invoice: {
      findUnique: (...args: unknown[]) => mockInvoiceFindUnique(...args),
    },
    tag: {
      findUnique: (...args: unknown[]) => mockTagFindUnique(...args),
      delete: (...args: unknown[]) => mockTagDelete(...args),
    },
    invoiceTag: {
      findUnique: (...args: unknown[]) => mockInvoiceTagFindUnique(...args),
      findMany: (...args: unknown[]) => mockInvoiceTagFindMany(...args),
      create: (...args: unknown[]) => mockInvoiceTagCreate(...args),
      delete: (...args: unknown[]) => mockInvoiceTagDelete(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { GET, POST, DELETE } from './route'

function makeRequest(
  url: string,
  options?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Invoice Tags API (/api/invoices/[id]/tags)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-1',
    })
    mockInvoiceTagFindUnique.mockResolvedValue(null)
  })

  it('rejects attaching a tag that does not belong to the invoice owner with 403', async () => {
    mockTagFindUnique.mockResolvedValue({
      id: 'tag-other',
      userId: 'user-2',
      name: 'Foreign Tag',
      color: '#ff0000',
    })

    const req = makeRequest('http://localhost/api/invoices/inv-1/tags', {
      token: 'valid-token',
      body: { tagId: 'tag-other' },
    })

    const res = await POST(req, { params: { id: 'inv-1' } })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.code).toBe('TAG_OWNERSHIP_MISMATCH')
    expect(mockInvoiceTagCreate).not.toHaveBeenCalled()
  })

  it('enforces the unique (invoiceId, tagId) constraint with a clean 409 on duplicate attach', async () => {
    mockTagFindUnique.mockResolvedValue({
      id: 'tag-1',
      userId: 'user-1',
      name: 'Retainer',
      color: '#6366f1',
    })
    mockInvoiceTagFindUnique.mockResolvedValue({
      id: 'it-existing',
      invoiceId: 'inv-1',
      tagId: 'tag-1',
    })

    const req = makeRequest('http://localhost/api/invoices/inv-1/tags', {
      token: 'valid-token',
      body: { tagId: 'tag-1' },
    })

    const res = await POST(req, { params: { id: 'inv-1' } })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('TAG_ALREADY_ATTACHED')
    expect(mockInvoiceTagCreate).not.toHaveBeenCalled()
  })

  it('attaches a tag on POST and removes the InvoiceTag link on DELETE without affecting the Tag definition itself', async () => {
    const now = new Date('2026-04-01T10:00:00Z')
    mockTagFindUnique.mockResolvedValue({
      id: 'tag-1',
      userId: 'user-1',
      name: 'Q2 Consulting',
      color: '#10b981',
      createdAt: now,
    })

    mockInvoiceTagCreate.mockResolvedValue({
      id: 'it-1',
      invoiceId: 'inv-1',
      tagId: 'tag-1',
      createdAt: now,
      tag: {
        id: 'tag-1',
        userId: 'user-1',
        name: 'Q2 Consulting',
        color: '#10b981',
        createdAt: now,
      },
    })

    const reqPost = makeRequest('http://localhost/api/invoices/inv-1/tags', {
      token: 'valid-token',
      body: { tagId: 'tag-1' },
    })
    const resPost = await POST(reqPost, { params: { id: 'inv-1' } })
    expect(resPost.status).toBe(201)
    const jsonPost = await resPost.json()
    expect(jsonPost.invoiceTag.tagId).toBe('tag-1')
    expect(jsonPost.invoiceTag.tag.name).toBe('Q2 Consulting')

    // Now detach the tag via DELETE
    mockInvoiceTagFindUnique.mockResolvedValueOnce({
      id: 'it-1',
      invoiceId: 'inv-1',
      tagId: 'tag-1',
    })
    mockInvoiceTagDelete.mockResolvedValueOnce({ id: 'it-1' })

    const reqDelete = makeRequest(
      'http://localhost/api/invoices/inv-1/tags?tagId=tag-1',
      {
        method: 'DELETE',
        token: 'valid-token',
      },
    )
    const resDelete = await DELETE(reqDelete, { params: { id: 'inv-1' } })
    expect(resDelete.status).toBe(200)
    const jsonDelete = await resDelete.json()
    expect(jsonDelete.detached).toBe(true)
    expect(mockInvoiceTagDelete).toHaveBeenCalledWith({
      where: { id: 'it-1' },
    })
    expect(mockTagDelete).not.toHaveBeenCalled()
  })
})
