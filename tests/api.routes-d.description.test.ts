import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createHash } from 'crypto'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindUnique = vi.fn()
const invoiceUpdate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: {
      findUnique: invoiceFindUnique,
      update: invoiceUpdate,
    },
  },
}))

const URL = 'http://localhost/api/routes-d/invoices/inv_1/description'

function generateETag(id: string, description: string, updatedAt: Date): string {
  const hash = createHash('sha256')
  hash.update(`${id}:${description}:${updatedAt.toISOString()}`)
  return `"${hash.digest('hex').substring(0, 8)}"`
}

function makeRequest(body: unknown, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(URL, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeGetRequest(headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(URL, {
    method: 'GET',
    headers,
  })
}

describe('PATCH /api/routes-d/invoices/[id]/description', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/description/route')
    const response = await PATCH(makeRequest({ description: 'Updated' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 400 for an empty description', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/description/route')
    const response = await PATCH(makeRequest({ description: '   ' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Description is required and must be a non-empty string',
    })
    expect(invoiceFindUnique).not.toHaveBeenCalled()
  })

  it('returns 403 when the invoice belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_2', status: 'pending' })

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/description/route')
    const response = await PATCH(makeRequest({ description: 'Updated' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(invoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 422 when the invoice is not pending', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1', status: 'paid' })

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/description/route')
    const response = await PATCH(makeRequest({ description: 'Updated' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'Only pending invoices can be updated' })
    expect(invoiceUpdate).not.toHaveBeenCalled()
  })

  it('updates the invoice description for the owner', async () => {
    const updatedAt = new Date('2026-01-01T00:00:00.000Z')
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1', status: 'pending' })
    invoiceUpdate.mockResolvedValue({
      id: 'inv_1',
      invoiceNumber: 'INV-001',
      description: 'Updated',
      updatedAt,
    })

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/description/route')
    const response = await PATCH(makeRequest({ description: ' Updated ' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: 'inv_1',
      invoiceNumber: 'INV-001',
      description: 'Updated',
      updatedAt: updatedAt.toISOString(),
    })
    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv_1' },
      data: { description: 'Updated' },
      select: {
        id: true,
        invoiceNumber: true,
        description: true,
        updatedAt: true,
      },
    })
    expect(response.headers.get('ETag')).toBeDefined()
  })

  it('returns ETag on GET', async () => {
    const updatedAt = new Date('2026-01-01T00:00:00.000Z')
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      description: 'Test',
      updatedAt,
    })

    const { GET } = await import('@/app/api/routes-d/invoices/[id]/description/route')
    const response = await GET(makeGetRequest(), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(200)
    const eTag = response.headers.get('ETag')
    expect(eTag).toBeDefined()
    expect(eTag).toMatch(/^"[a-f0-9]{8}"$/)
  })

  it('rejects PATCH with mismatched If-Match header', async () => {
    const updatedAt = new Date('2026-01-01T00:00:00.000Z')
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      status: 'pending',
      description: 'Original',
      updatedAt,
    })

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/description/route')
    const response = await PATCH(makeRequest({ description: 'Updated' }, {
      authorization: 'Bearer token',
      'if-match': '"wronghash"',
    }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(412)
    await expect(response.json()).resolves.toEqual({
      error: 'ETag mismatch - invoice may have been modified',
      code: 'PRECONDITION_FAILED',
    })
    expect(invoiceUpdate).not.toHaveBeenCalled()
  })

  it('accepts PATCH with matching If-Match header', async () => {
    const originalUpdatedAt = new Date('2026-01-01T00:00:00.000Z')
    const newUpdatedAt = new Date('2026-01-02T00:00:00.000Z')
    const originalETag = generateETag('inv_1', 'Original', originalUpdatedAt)

    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      status: 'pending',
      description: 'Original',
      updatedAt: originalUpdatedAt,
    })
    invoiceUpdate.mockResolvedValue({
      id: 'inv_1',
      invoiceNumber: 'INV-001',
      description: 'Updated',
      updatedAt: newUpdatedAt,
    })

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/description/route')
    const response = await PATCH(makeRequest({ description: 'Updated' }, {
      authorization: 'Bearer token',
      'if-match': originalETag,
    }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(200)
    expect(invoiceUpdate).toHaveBeenCalled()
    expect(response.headers.get('ETag')).toBeDefined()
  })
})
