/**
 * Tests for issue #703 — GET,POST /api/routes-b/invoices/[id]/tags
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    tag: { findMany: vi.fn() },
    invoiceTag: { findMany: vi.fn(), create: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, POST } from '../invoices/[id]/tags/route'

const params = Promise.resolve({ id: 'inv-1' })

function makeGetRequest(authHeader: string | null = 'Bearer token') {
  return new NextRequest('http://localhost/api/routes-b/invoices/inv-1/tags', {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function makePostRequest(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest('http://localhost/api/routes-b/invoices/inv-1/tags', {
    method: 'POST',
    headers: {
      ...(authHeader ? { authorization: authHeader } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-b/invoices/[id]/tags (#703)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  })

  it('returns 401 when token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as never)
    const res = await GET(makeGetRequest(), { params })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when invoice does not exist', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue(null as never)
    const res = await GET(makeGetRequest(), { params })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Invoice not found' })
  })

  it('returns 403 when invoice belongs to another user', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ id: 'inv-1', userId: 'user-2' } as never)
    const res = await GET(makeGetRequest(), { params })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'Forbidden' })
  })

  it('returns tags attached to the invoice', async () => {
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ id: 'inv-1', userId: 'user-1' } as never)
    vi.mocked(prisma.invoiceTag.findMany).mockResolvedValue([
      { tag: { id: 'tag-1', name: 'Priority', color: '#ff0000' } },
    ] as never)

    const res = await GET(makeGetRequest(), { params })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      tags: [{ id: 'tag-1', name: 'Priority', color: '#ff0000' }],
    })
  })
})

describe('POST /api/routes-b/invoices/[id]/tags (#703)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({ id: 'inv-1', userId: 'user-1' } as never)
  })

  it('returns 400 for invalid tagIds payload', async () => {
    const res = await POST(makePostRequest({ tagIds: [''] }), { params })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'tagIds must be a non-empty string array' })
  })

  it('returns 403 when attaching tags owned by another user', async () => {
    vi.mocked(prisma.tag.findMany).mockResolvedValue([
      { id: 'tag-1', name: 'Other', color: '#000', userId: 'user-2' },
    ] as never)

    const res = await POST(makePostRequest({ tagIds: ['tag-1'] }), { params })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'Foreign tags are not allowed' })
  })

  it('attaches owned tags to the invoice', async () => {
    vi.mocked(prisma.tag.findMany).mockResolvedValue([
      { id: 'tag-1', name: 'Alpha', color: '#111', userId: 'user-1' },
      { id: 'tag-2', name: 'Beta', color: '#222', userId: 'user-1' },
    ] as never)
    vi.mocked(prisma.invoiceTag.create).mockResolvedValue({} as never)

    const res = await POST(makePostRequest({ tagIds: ['tag-1', 'tag-2'] }), { params })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({
      invoiceId: 'inv-1',
      attachedTagIds: ['tag-1', 'tag-2'],
      createdTagIds: ['tag-1', 'tag-2'],
    })
    expect(prisma.invoiceTag.create).toHaveBeenCalledTimes(2)
  })
})
