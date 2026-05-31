import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    contact: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $queryRawUnsafe: vi.fn(),
  },
}))

vi.mock('../../_lib/flags', () => ({
  ENABLE_CONTACTS_SOFT_DELETE: true,
}))

vi.mock('../../_lib/table-columns', () => ({
  hasTableColumn: vi.fn(),
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { hasTableColumn } from '../../_lib/table-columns'
import { DELETE, GET } from '../[id]/route'

const mockVerify = vi.mocked(verifyAuthToken)
const mockUserFind = vi.mocked(prisma.user.findUnique)
const mockQueryRaw = vi.mocked(prisma.$queryRawUnsafe)
const mockHasColumn = vi.mocked(hasTableColumn)

const fakeUser = { id: 'user-1', privyId: 'privy-1', role: 'freelancer' }

const activeContact = {
  id: 'contact-1',
  userId: 'user-1',
  name: 'Bob Smith',
  email: 'bob@example.com',
  company: null,
  notes: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  deletedAt: null,
}

function makeDeleteReq(id = 'contact-1'): [NextRequest, { params: { id: string } }] {
  return [
    new NextRequest(`http://localhost/api/routes-b/contacts/${id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer tok' },
    }),
    { params: { id } },
  ]
}

function makeGetReq(id = 'contact-1', includeDeleted = false): [NextRequest, { params: { id: string } }] {
  const url = `http://localhost/api/routes-b/contacts/${id}${includeDeleted ? '?includeDeleted=true' : ''}`
  return [
    new NextRequest(url, {
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
    }),
    { params: { id } },
  ]
}

describe('DELETE /api/routes-b/contacts/[id] — soft delete', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockUserFind.mockResolvedValue(fakeUser as never)
    mockHasColumn.mockResolvedValue(true)
  })

  it('soft-deletes a contact and returns the deleted record', async () => {
    const deletedAt = new Date()
    mockQueryRaw
      // findContactById call
      .mockResolvedValueOnce([activeContact] as never)
      // softDeleteContact call
      .mockResolvedValueOnce([{ ...activeContact, deletedAt }] as never)

    const [req, ctx] = makeDeleteReq()
    const res = await DELETE(req, ctx)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.contact.deletedAt).toBeDefined()
    expect(body.contact.id).toBe('contact-1')
  })

  it('returns 404 when contact does not exist for user', async () => {
    // findContactById returns empty (contact not found)
    mockQueryRaw.mockResolvedValueOnce([] as never)

    const [req, ctx] = makeDeleteReq('nonexistent')
    const res = await DELETE(req, ctx)

    expect(res.status).toBe(404)
  })

  it('returns 404 when contact is already soft-deleted', async () => {
    // findContactById excludes deletedAt IS NOT NULL — returns empty
    mockQueryRaw.mockResolvedValueOnce([] as never)

    const [req, ctx] = makeDeleteReq()
    const res = await DELETE(req, ctx)

    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    mockVerify.mockResolvedValue(null as never)

    const [req, ctx] = makeDeleteReq()
    const res = await DELETE(req, ctx)

    expect(res.status).toBe(401)
  })

  it('returns 409 when soft delete is not supported (flag off + no column)', async () => {
    mockHasColumn.mockResolvedValue(false)

    // findContactById falls back to Prisma (no soft-delete support)
    vi.mocked(prisma.contact.findFirst).mockResolvedValue(activeContact as never)

    const [req, ctx] = makeDeleteReq()
    const res = await DELETE(req, ctx)

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/soft delete not supported/i)
  })
})

describe('GET /api/routes-b/contacts/[id] — soft-delete visibility', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockUserFind.mockResolvedValue(fakeUser as never)
    mockHasColumn.mockResolvedValue(true)
  })

  it('returns active contact without includeDeleted', async () => {
    mockQueryRaw.mockResolvedValueOnce([activeContact] as never)

    const [req, ctx] = makeGetReq()
    const res = await GET(req, ctx)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.contact.id).toBe('contact-1')
  })

  it('returns 404 for soft-deleted contact when includeDeleted=false', async () => {
    // query filters out deletedAt IS NOT NULL, returns empty
    mockQueryRaw.mockResolvedValueOnce([] as never)

    const [req, ctx] = makeGetReq('contact-1', false)
    const res = await GET(req, ctx)

    expect(res.status).toBe(404)
  })

  it('returns soft-deleted contact when includeDeleted=true', async () => {
    const deletedContact = { ...activeContact, deletedAt: new Date() }
    mockQueryRaw.mockResolvedValueOnce([deletedContact] as never)

    const [req, ctx] = makeGetReq('contact-1', true)
    const res = await GET(req, ctx)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.contact.deletedAt).toBeDefined()
  })

  it('preserves linked invoice integrity (contact not hard-deleted)', async () => {
    // Soft delete does NOT call prisma.contact.delete — it sets deletedAt via raw UPDATE
    const deletedAt = new Date()
    mockQueryRaw
      .mockResolvedValueOnce([activeContact] as never)
      .mockResolvedValueOnce([{ ...activeContact, deletedAt }] as never)

    const [req, ctx] = makeDeleteReq()
    await DELETE(req, ctx)

    // prisma.contact.delete must never be called (hard delete would break FK constraints)
    expect(vi.mocked(prisma.contact.update)).not.toHaveBeenCalled()
  })
})
