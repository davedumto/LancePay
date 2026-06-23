import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const userFindFirst = vi.fn()
const invoiceFindMany = vi.fn()
const invoiceUpdateMany = vi.fn()
const userDelete = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique, findFirst: userFindFirst, delete: userDelete },
    invoice: { findMany: invoiceFindMany, updateMany: invoiceUpdateMany },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/clients/test-id/merge'

function makeRequest(method: string, body?: unknown) {
  return new NextRequest(BASE_URL, {
    method,
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function makeParams(id: string = 'test-id') {
  return Promise.resolve({ id })
}

describe('POST /api/routes-b/clients/[id]/merge', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/clients/[id]/merge/route')
    const res = await POST(makeRequest('POST', { duplicateClientId: 'dup-id' }), { params: makeParams() })
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/clients/[id]/merge/route')
    const res = await POST(makeRequest('POST', { duplicateClientId: 'dup-id' }), { params: makeParams() })
    expect(res.status).toBe(404)
  })

  it('returns 400 when duplicateClientId is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/clients/[id]/merge/route')
    const res = await POST(makeRequest('POST', {}), { params: makeParams() })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/duplicateClientId/)
  })

  it('returns 400 when trying to merge client with itself', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/clients/[id]/merge/route')
    const res = await POST(makeRequest('POST', { duplicateClientId: 'test-id' }), { params: makeParams() })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Cannot merge a client with itself/)
  })

  it('returns 404 when primary client is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValueOnce(null)
    const { POST } = await import('@/app/api/routes-b/clients/[id]/merge/route')
    const res = await POST(makeRequest('POST', { duplicateClientId: 'dup-id' }), { params: makeParams() })
    expect(res.status).toBe(404)
  })

  it('returns 404 when duplicate client is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValueOnce({ id: 'test-id', role: 'client' })
    userFindFirst.mockResolvedValueOnce(null)
    const { POST } = await import('@/app/api/routes-b/clients/[id]/merge/route')
    const res = await POST(makeRequest('POST', { duplicateClientId: 'dup-id' }), { params: makeParams() })
    expect(res.status).toBe(404)
  })

  it('returns 403 when user has no ownership over clients', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValueOnce({ id: 'test-id', role: 'client' })
    userFindFirst.mockResolvedValueOnce({ id: 'dup-id', role: 'client' })
    invoiceFindMany.mockResolvedValue([])
    const { POST } = await import('@/app/api/routes-b/clients/[id]/merge/route')
    const res = await POST(makeRequest('POST', { duplicateClientId: 'dup-id' }), { params: makeParams() })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toMatch(/No ownership/)
  })

  it('merges clients successfully and returns 200', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValueOnce({ id: 'test-id', role: 'client' })
    userFindFirst.mockResolvedValueOnce({ id: 'dup-id', role: 'client' })
    invoiceFindMany.mockResolvedValueOnce([])
    invoiceFindMany.mockResolvedValueOnce([{ id: 'inv_1' }, { id: 'inv_2' }])
    invoiceUpdateMany.mockResolvedValue({ count: 2 })
    userDelete.mockResolvedValue({ id: 'dup-id' })
    const { POST } = await import('@/app/api/routes-b/clients/[id]/merge/route')
    const res = await POST(makeRequest('POST', { duplicateClientId: 'dup-id' }), { params: makeParams() })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.message).toBe('Clients merged successfully')
    expect(json.primaryClientId).toBe('test-id')
    expect(json.duplicateClientId).toBe('dup-id')
    expect(json.invoicesMerged).toBe(2)
  })

  it('updates invoices from duplicate to primary client', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValueOnce({ id: 'test-id', role: 'client' })
    userFindFirst.mockResolvedValueOnce({ id: 'dup-id', role: 'client' })
    invoiceFindMany.mockResolvedValueOnce([])
    invoiceFindMany.mockResolvedValueOnce([{ id: 'inv_1' }])
    invoiceUpdateMany.mockResolvedValue({ count: 1 })
    userDelete.mockResolvedValue({ id: 'dup-id' })
    const { POST } = await import('@/app/api/routes-b/clients/[id]/merge/route')
    await POST(makeRequest('POST', { duplicateClientId: 'dup-id' }), { params: makeParams() })
    expect(invoiceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientId: 'dup-id',
          userId: 'user_1',
        },
        data: { clientId: 'test-id' },
      }),
    )
  })

  it('deletes the duplicate client after merge', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    userFindFirst.mockResolvedValueOnce({ id: 'test-id', role: 'client' })
    userFindFirst.mockResolvedValueOnce({ id: 'dup-id', role: 'client' })
    invoiceFindMany.mockResolvedValueOnce([])
    invoiceFindMany.mockResolvedValueOnce([{ id: 'inv_1' }])
    invoiceUpdateMany.mockResolvedValue({ count: 1 })
    userDelete.mockResolvedValue({ id: 'dup-id' })
    const { POST } = await import('@/app/api/routes-b/clients/[id]/merge/route')
    await POST(makeRequest('POST', { duplicateClientId: 'dup-id' }), { params: makeParams() })
    expect(userDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dup-id' },
      }),
    )
  })
})
