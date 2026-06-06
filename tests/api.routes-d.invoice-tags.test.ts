import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindUnique = vi.fn()
const tagFindUnique = vi.fn()
const invoiceTagCreate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findUnique: invoiceFindUnique },
    tag: { findUnique: tagFindUnique },
    invoiceTag: { create: invoiceTagCreate },
  },
}))

const URL = 'http://localhost/api/routes-d/invoices/inv_1/tags'

function makeRequest(body: unknown, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-d/invoices/[id]/tags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the authorization header is missing', async () => {
    const { POST } = await import('@/app/api/routes-d/invoices/[id]/tags/route')
    const response = await POST(makeRequest({ tagId: 'tag_1' }, {}), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(verifyAuthToken).not.toHaveBeenCalled()
  })

  it('returns 400 when tagId is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-d/invoices/[id]/tags/route')
    const response = await POST(makeRequest({}), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'tagId is required' })
    expect(invoiceFindUnique).not.toHaveBeenCalled()
  })

  it('returns 403 when the invoice belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_2' })

    const { POST } = await import('@/app/api/routes-d/invoices/[id]/tags/route')
    const response = await POST(makeRequest({ tagId: 'tag_1' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(tagFindUnique).not.toHaveBeenCalled()
  })

  it('returns 403 when the tag belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1' })
    tagFindUnique.mockResolvedValue({ id: 'tag_1', name: 'Urgent', color: '#111111', userId: 'user_2' })

    const { POST } = await import('@/app/api/routes-d/invoices/[id]/tags/route')
    const response = await POST(makeRequest({ tagId: 'tag_1' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(invoiceTagCreate).not.toHaveBeenCalled()
  })

  it('attaches a tag to an owned invoice', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1' })
    tagFindUnique.mockResolvedValue({ id: 'tag_1', name: 'Urgent', color: '#111111', userId: 'user_1' })
    invoiceTagCreate.mockResolvedValue({ invoiceId: 'inv_1', tagId: 'tag_1' })

    const { POST } = await import('@/app/api/routes-d/invoices/[id]/tags/route')
    const response = await POST(makeRequest({ tagId: ' tag_1 ' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      invoiceId: 'inv_1',
      tagId: 'tag_1',
      tagName: 'Urgent',
      tagColor: '#111111',
    })
    expect(invoiceTagCreate).toHaveBeenCalledWith({
      data: { invoiceId: 'inv_1', tagId: 'tag_1' },
    })
  })

  it('is idempotent when the tag is already attached', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1' })
    tagFindUnique.mockResolvedValue({ id: 'tag_1', name: 'Urgent', color: '#111111', userId: 'user_1' })
    invoiceTagCreate.mockRejectedValue({ code: 'P2002' })

    const { POST } = await import('@/app/api/routes-d/invoices/[id]/tags/route')
    const response = await POST(makeRequest({ tagId: 'tag_1' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      invoiceId: 'inv_1',
      tagId: 'tag_1',
      tagName: 'Urgent',
      tagColor: '#111111',
    })
  })
})
