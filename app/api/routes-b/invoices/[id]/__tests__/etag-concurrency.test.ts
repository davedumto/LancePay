import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createEntityEtag } from '@/app/api/routes-b/_lib/etag'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindUnique = vi.fn()
const invoiceUpdate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: {
      findUnique: invoiceFindUnique,
      update: invoiceUpdate,
    },
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: loggerError },
}))

describe('routes-b invoice ETag + If-Match', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
  })

  it('GET returns opaque ETag header', async () => {
    const updatedAt = new Date('2026-02-01T10:00:00.000Z')
    invoiceFindUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      invoiceNumber: 'INV-1',
      clientEmail: 'c@example.com',
      clientName: 'Client',
      description: 'Work',
      amount: 120,
      currency: 'USD',
      status: 'pending',
      paymentLink: 'https://pay',
      dueDate: null,
      paidAt: null,
      createdAt: new Date('2026-02-01T09:00:00.000Z'),
      updatedAt,
    })

    const { GET } = await import('@/app/api/routes-b/invoices/[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/invoices/inv_1', {
      headers: { authorization: 'Bearer token' },
    })
    const response = await GET(request, { params: Promise.resolve({ id: 'inv_1' }) })
    expect(response.status).toBe(200)
    expect(response.headers.get('ETag')).toBe(createEntityEtag('inv_1', updatedAt))
  })

  it('PATCH returns 428 when If-Match is missing', async () => {
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/invoices/inv_1', {
      method: 'PATCH',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'updated' }),
    })
    const response = await PATCH(request, { params: Promise.resolve({ id: 'inv_1' }) })
    expect(response.status).toBe(428)
  })

  it('PATCH returns 412 for stale If-Match', async () => {
    invoiceFindUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      status: 'pending',
      updatedAt: new Date('2026-02-01T10:00:00.000Z'),
    })
    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/invoices/inv_1', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer token',
        'if-match': '"stale"',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ description: 'updated' }),
    })
    const response = await PATCH(request, { params: Promise.resolve({ id: 'inv_1' }) })
    expect(response.status).toBe(412)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'CONFLICT', message: 'ETag mismatch' },
    })
  })

  it('PATCH succeeds with matching If-Match', async () => {
    const updatedAt = new Date('2026-02-01T10:00:00.000Z')
    invoiceFindUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      status: 'pending',
      updatedAt,
    })
    invoiceUpdate.mockResolvedValue({
      id: 'inv_1',
      invoiceNumber: 'INV-1',
      description: 'updated',
      amount: 120,
      status: 'pending',
      updatedAt: new Date('2026-02-01T11:00:00.000Z'),
      dueDate: null,
      clientName: 'Client',
      clientEmail: 'c@example.com',
      currency: 'USD',
      paymentLink: 'https://pay',
      paidAt: null,
      createdAt: new Date('2026-02-01T09:00:00.000Z'),
    })

    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/invoices/inv_1', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer token',
        'if-match': createEntityEtag('inv_1', updatedAt),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ description: 'updated' }),
    })
    const response = await PATCH(request, { params: Promise.resolve({ id: 'inv_1' }) })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.invoice).toMatchObject({ id: 'inv_1', description: 'updated', amount: 120 })
    expect(invoiceUpdate).toHaveBeenCalledOnce()
  })

  it('PATCH allows If-Match:* for admin users', async () => {
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'admin' })
    invoiceFindUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      status: 'pending',
      updatedAt: new Date('2026-02-01T10:00:00.000Z'),
    })
    invoiceUpdate.mockResolvedValue({
      id: 'inv_1',
      invoiceNumber: 'INV-1',
      description: 'force',
      amount: 120,
      status: 'pending',
      updatedAt: new Date('2026-02-01T11:00:00.000Z'),
      dueDate: null,
      clientName: 'Client',
      clientEmail: 'c@example.com',
      currency: 'USD',
      paymentLink: 'https://pay',
      paidAt: null,
      createdAt: new Date('2026-02-01T09:00:00.000Z'),
    })

    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/invoices/inv_1', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer token',
        'if-match': '*',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ description: 'force' }),
    })
    const response = await PATCH(request, { params: Promise.resolve({ id: 'inv_1' }) })
    expect(response.status).toBe(200)
  })

  it('GET hides invoices owned by another user', async () => {
    invoiceFindUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_2',
      invoiceNumber: 'INV-1',
      clientEmail: 'c@example.com',
      clientName: 'Client',
      description: 'Work',
      amount: 120,
      currency: 'USD',
      status: 'pending',
      paymentLink: 'https://pay',
      dueDate: null,
      paidAt: null,
      createdAt: new Date('2026-02-01T09:00:00.000Z'),
      updatedAt: new Date('2026-02-01T10:00:00.000Z'),
    })

    const { GET } = await import('@/app/api/routes-b/invoices/[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/invoices/inv_1', {
      headers: { authorization: 'Bearer token' },
    })
    const response = await GET(request, { params: Promise.resolve({ id: 'inv_1' }) })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Invoice not found' },
    })
  })

  it('PATCH rejects invalid fields with structured errors', async () => {
    invoiceFindUnique.mockResolvedValue({
      id: 'inv_1',
      userId: 'user_1',
      status: 'pending',
      updatedAt: new Date('2026-02-01T10:00:00.000Z'),
    })

    const { PATCH } = await import('@/app/api/routes-b/invoices/[id]/route')
    const request = new NextRequest('http://localhost/api/routes-b/invoices/inv_1', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer token',
        'if-match': createEntityEtag('inv_1', new Date('2026-02-01T10:00:00.000Z')),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount: -1 }),
    })
    const response = await PATCH(request, { params: Promise.resolve({ id: 'inv_1' }) })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'BAD_REQUEST',
        fields: { amount: 'Must be a positive number' },
      },
    })
    expect(invoiceUpdate).not.toHaveBeenCalled()
  })
})
