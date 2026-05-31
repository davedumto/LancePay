import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

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

const BASE_URL = 'http://localhost/api/routes-d/invoices/inv_1/due-date'

function makeRequest(body: unknown, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(BASE_URL, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/routes-d/invoices/[id]/due-date', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/due-date/route')
    const response = await PATCH(makeRequest({ dueDate: '2099-01-01' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 403 when the invoice belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_2', status: 'pending' })

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/due-date/route')
    const response = await PATCH(makeRequest({ dueDate: '2099-01-01' }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(invoiceUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 when dueDate is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1', status: 'pending' })

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/due-date/route')
    const response = await PATCH(makeRequest({}), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'dueDate is required' })
    expect(invoiceUpdate).not.toHaveBeenCalled()
  })

  it('updates a pending invoice due date', async () => {
    const dueDate = '2099-01-01T00:00:00.000Z'
    const updated = { id: 'inv_1', invoiceNumber: 'INV-001', dueDate: new Date(dueDate) }

    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1', status: 'pending' })
    invoiceUpdate.mockResolvedValue(updated)

    const { PATCH } = await import('@/app/api/routes-d/invoices/[id]/due-date/route')
    const response = await PATCH(makeRequest({ dueDate }), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: 'inv_1',
      invoiceNumber: 'INV-001',
      dueDate,
    })
    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv_1' },
      data: { dueDate: new Date(dueDate) },
      select: {
        id: true,
        invoiceNumber: true,
        dueDate: true,
      },
    })
  })
})
