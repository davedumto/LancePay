import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createEntityEtag } from '@/app/api/routes-b/_lib/etag'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindUnique = vi.fn()
const invoiceFindFirst = vi.fn()
const invoiceUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: {
      findUnique: invoiceFindUnique,
      findFirst: invoiceFindFirst,
      update: invoiceUpdate,
    },
  },
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
    invoiceFindFirst.mockResolvedValue({
      id: 'inv_1',
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
  })

  it('PATCH succeeds with matching If-Match', async () => {
    const updatedAt = new Date('2026-02-01T10:00:00.000Z')
    invoiceFindFirst.mockResolvedValue({
      id: 'inv_1',
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
    expect(response.status).toBe(200)
    expect(invoiceUpdate).toHaveBeenCalledOnce()
  })

  it('PATCH allows If-Match:* for admin users', async () => {
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'admin' })
    invoiceFindFirst.mockResolvedValue({
      id: 'inv_1',
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
})

