import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    tag: { findUnique: vi.fn() },
    invoiceTag: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  }
  return { prisma }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET, POST, DELETE } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const NOW = new Date('2026-11-18T12:00:00.000Z')

function makeRequest(method: 'GET' | 'POST' | 'DELETE', body?: string, headers: Record<string, string> = { authorization: 'Bearer token' }, url = 'http://localhost/api/invoices/invoice-1/tags') {
  return new NextRequest(url, { method, headers, body })
}

function mockInvoiceTag(overrides: Record<string, unknown> = {}) {
  return {
    id: 'it-1',
    tagId: 'tag-1',
    tag: {
      id: 'tag-1',
      name: 'urgent',
      color: '#ff0000',
    },
    createdAt: NOW,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
})

describe('GET /api/invoices/[id]/tags', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await GET(makeRequest('GET', undefined, {}), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(401)
    expect(prisma.invoiceTag.findMany).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(401)
    expect(prisma.invoiceTag.findMany).not.toHaveBeenCalled()
  })

  it('returns 400 when invoice ID is missing', async () => {
    const res = await GET(makeRequest('GET'), { params: { id: '' } })
    expect(res.status).toBe(400)
    expect(prisma.invoiceTag.findMany).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params: { id: 'nonexistent' } })
    expect(res.status).toBe(404)
    expect(prisma.invoiceTag.findMany).not.toHaveBeenCalled()
  })

  it('returns 403 when the invoice belongs to a different user', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'other-user' } as never)
    const res = await GET(makeRequest('GET'), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(403)
    expect(prisma.invoiceTag.findMany).not.toHaveBeenCalled()
  })

  it('returns an empty list when the invoice has no tags', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.invoiceTag.findMany).mockResolvedValue([])

    const res = await GET(makeRequest('GET'), { params: { id: 'invoice-1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.tags).toEqual([])
  })

  it('returns all tags attached to the invoice ordered by createdAt descending', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    const tag1 = mockInvoiceTag({ id: 'it-1', tagId: 'tag-1', createdAt: NOW })
    const tag2 = mockInvoiceTag({ id: 'it-2', tagId: 'tag-2', createdAt: new Date('2026-11-17T12:00:00.000Z') })
    vi.mocked(prisma.invoiceTag.findMany).mockResolvedValue([tag1, tag2] as never)

    const res = await GET(makeRequest('GET'), { params: { id: 'invoice-1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.tags).toHaveLength(2)
    expect(body.tags[0].tagId).toBe('tag-1')

    expect(prisma.invoiceTag.findMany).toHaveBeenCalledWith({
      where: { invoiceId: 'invoice-1' },
      select: expect.objectContaining({
        id: true,
        tagId: true,
        tag: expect.any(Object),
        createdAt: true,
      }),
      orderBy: { createdAt: 'desc' },
    })
  })

  it('returns a generic 500 on database error', async () => {
    vi.mocked(prisma.invoice.findUnique).mockRejectedValue(new Error('connection refused'))
    const res = await GET(makeRequest('GET'), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to fetch tags' })
  })
})

describe('POST /api/invoices/[id]/tags', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'tag-1' }), {}), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(401)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'tag-1' })), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(401)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('returns 400 when invoice ID is missing', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'tag-1' })), { params: { id: '' } })
    expect(res.status).toBe(400)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'tag-1' })), { params: { id: 'nonexistent' } })
    expect(res.status).toBe(404)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('returns 403 when the invoice belongs to a different user', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'other-user' } as never)
    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'tag-1' })), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(403)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('returns 404 when the tag does not exist', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.tag.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'nonexistent' })), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(404)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('returns 403 when the tag belongs to a different user', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.tag.findUnique).mockResolvedValue({ userId: 'other-user' } as never)
    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'tag-1' })), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Tag does not belong to you' })
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('attaches a tag to an invoice', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.tag.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    const invoiceTag = mockInvoiceTag()
    vi.mocked(prisma.invoiceTag.create).mockResolvedValue(invoiceTag as never)

    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'tag-1' })), { params: { id: 'invoice-1' } })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.invoiceTag).toEqual(invoiceTag)

    expect(prisma.invoiceTag.create).toHaveBeenCalledWith({
      data: {
        invoiceId: 'invoice-1',
        tagId: 'tag-1',
      },
      select: expect.any(Object),
    })
  })

  it('returns 409 when trying to attach a duplicate tag', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.tag.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.invoiceTag.create).mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    )

    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'tag-1' })), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Tag is already attached to this invoice' })
  })

  it('rejects malformed JSON', async () => {
    const res = await POST(makeRequest('POST', '{not json'), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(400)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('rejects an empty body', async () => {
    const res = await POST(makeRequest('POST', ''), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(400)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('rejects a request with missing tagId', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({})), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(400)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('rejects an empty tagId', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: '   ' })), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(400)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('rejects unknown fields such as client-supplied userId', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'tag-1', userId: 'someone-else' })), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(400)
    expect(prisma.invoiceTag.create).not.toHaveBeenCalled()
  })

  it('returns a generic 500 on database error', async () => {
    vi.mocked(prisma.invoice.findUnique).mockRejectedValue(new Error('connection refused'))
    const res = await POST(makeRequest('POST', JSON.stringify({ tagId: 'tag-1' })), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to attach tag' })
  })
})

describe('DELETE /api/invoices/[id]/tags', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await DELETE(makeRequest('DELETE', undefined, {}), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(401)
    expect(prisma.invoiceTag.delete).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/invoices/invoice-1/tags?tagId=tag-1'), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(401)
    expect(prisma.invoiceTag.delete).not.toHaveBeenCalled()
  })

  it('returns 400 when invoice ID is missing', async () => {
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/invoices//tags?tagId=tag-1'), { params: { id: '' } })
    expect(res.status).toBe(400)
    expect(prisma.invoiceTag.delete).not.toHaveBeenCalled()
  })

  it('returns 400 when tagId query parameter is missing', async () => {
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/invoices/invoice-1/tags'), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(400)
    expect(prisma.invoiceTag.delete).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(null)
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/invoices/nonexistent/tags?tagId=tag-1'), { params: { id: 'nonexistent' } })
    expect(res.status).toBe(404)
    expect(prisma.invoiceTag.delete).not.toHaveBeenCalled()
  })

  it('returns 403 when the invoice belongs to a different user', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'other-user' } as never)
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/invoices/invoice-1/tags?tagId=tag-1'), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(403)
    expect(prisma.invoiceTag.delete).not.toHaveBeenCalled()
  })

  it('returns 404 when the tag is not attached to the invoice', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.invoiceTag.findUnique).mockResolvedValue(null)
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/invoices/invoice-1/tags?tagId=tag-1'), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Tag is not attached to this invoice' })
    expect(prisma.invoiceTag.delete).not.toHaveBeenCalled()
  })

  it('removes a tag from an invoice', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.invoiceTag.findUnique).mockResolvedValue({ id: 'it-1' } as never)
    vi.mocked(prisma.invoiceTag.delete).mockResolvedValue({} as never)

    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/invoices/invoice-1/tags?tagId=tag-1'), { params: { id: 'invoice-1' } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    expect(prisma.invoiceTag.delete).toHaveBeenCalledWith({
      where: {
        invoiceId_tagId: {
          invoiceId: 'invoice-1',
          tagId: 'tag-1',
        },
      },
    })
  })

  it('ignores whitespace in the tagId parameter', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.invoiceTag.findUnique).mockResolvedValue({ id: 'it-1' } as never)
    vi.mocked(prisma.invoiceTag.delete).mockResolvedValue({} as never)

    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/invoices/invoice-1/tags?tagId=  tag-1  '), { params: { id: 'invoice-1' } })

    expect(res.status).toBe(200)
    expect(prisma.invoiceTag.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          invoiceId_tagId: {
            invoiceId: 'invoice-1',
            tagId: 'tag-1',
          },
        }),
      }),
    )
  })

  it('does not delete the Tag itself, only the InvoiceTag join row', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.invoiceTag.findUnique).mockResolvedValue({ id: 'it-1' } as never)
    vi.mocked(prisma.invoiceTag.delete).mockResolvedValue({} as never)

    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/invoices/invoice-1/tags?tagId=tag-1'), { params: { id: 'invoice-1' } })

    expect(res.status).toBe(200)
    // Verify only invoiceTag.delete is called, not tag.delete
    expect(prisma.invoiceTag.delete).toHaveBeenCalled()
  })

  it('returns a generic 500 on database error', async () => {
    vi.mocked(prisma.invoice.findUnique).mockRejectedValue(new Error('connection refused'))
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/invoices/invoice-1/tags?tagId=tag-1'), { params: { id: 'invoice-1' } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to remove tag' })
  })
})
