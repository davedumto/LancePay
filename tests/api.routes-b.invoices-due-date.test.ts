import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindUnique = vi.fn()
const invoiceUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findUnique: invoiceFindUnique, update: invoiceUpdate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/invoices/inv-123/due-date'

function makeRequest(method: string, body?: unknown) {
  return new NextRequest(BASE_URL, {
    method,
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('PATCH /api/routes-b/invoices/[id]/due-date', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/due-date/route')
    const res = await PATCH(makeRequest('PATCH', { dueDate: '2099-01-01' }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue(null)
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/due-date/route')
    const res = await PATCH(makeRequest('PATCH', { dueDate: '2099-01-01' }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Invoice not found' })
  })

  it('returns 403 when invoice belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_2', status: 'pending' })
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/due-date/route')
    const res = await PATCH(makeRequest('PATCH', { dueDate: '2099-01-01' }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'Forbidden' })
  })

  it('returns 422 if invoice is not pending', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_1', status: 'paid' })
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/due-date/route')
    const res = await PATCH(makeRequest('PATCH', { dueDate: '2099-01-01' }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(422)
    await expect(res.json()).resolves.toEqual({ error: 'Due date can only be updated on pending invoices' })
  })

  it('returns 400 when dueDate is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_1', status: 'pending' })
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/due-date/route')
    const res = await PATCH(makeRequest('PATCH', {}), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'dueDate is required' })
  })

  it('returns 400 for past date', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_1', status: 'pending' })
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/due-date/route')
    const res = await PATCH(makeRequest('PATCH', { dueDate: '2020-01-01' }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'Due date must be a future date' })
  })

  it('successfully updates due date to a future date', async () => {
    const futureDate = '2099-12-31'
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_1', status: 'pending' })
    invoiceUpdate.mockResolvedValue({ id: 'inv-123', invoiceNumber: 'INV-001', dueDate: new Date(futureDate) })
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/due-date/route')
    const res = await PATCH(makeRequest('PATCH', { dueDate: futureDate }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(200)
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-123' },
        data: { dueDate: expect.any(Date) },
      })
    )
  })

  it('successfully clears due date when dueDate is null', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-123', userId: 'user_1', status: 'pending' })
    invoiceUpdate.mockResolvedValue({ id: 'inv-123', invoiceNumber: 'INV-001', dueDate: null })
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/due-date/route')
    const res = await PATCH(makeRequest('PATCH', { dueDate: null }), { params: Promise.resolve({ id: 'inv-123' }) })
    expect(res.status).toBe(200)
    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv-123' },
      data: { dueDate: null },
      select: { id: true, invoiceNumber: true, dueDate: true },
    })
  })
})
