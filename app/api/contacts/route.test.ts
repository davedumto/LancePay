import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    contact: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const contactRow = {
  id: 'contact-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: null,
  company: null,
  notes: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

function getRequest(query = '', headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(`http://localhost/api/contacts${query}`, { method: 'GET', headers })
}

function postRequest(body: unknown, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest('http://localhost/api/contacts', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function uniqueError() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.contact.findMany).mockResolvedValue([contactRow] as never)
  vi.mocked(prisma.contact.count).mockResolvedValue(1)
  vi.mocked(prisma.contact.findFirst).mockResolvedValue(null)
  vi.mocked(prisma.contact.create).mockResolvedValue(contactRow as never)
  vi.mocked(prisma.contact.update).mockResolvedValue(contactRow as never)
})

describe('GET /api/contacts', () => {
  it('lists only the caller\'s non-deleted contacts', async () => {
    const res = await GET(getRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.contacts).toHaveLength(1)
    expect(data).toMatchObject({ total: 1, page: 1, limit: 20 })
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', deletedAt: null }, skip: 0, take: 20 }),
    )
    expect(prisma.contact.count).toHaveBeenCalledWith({ where: { userId: 'user-1', deletedAt: null } })
  })

  it('paginates and caps the page size', async () => {
    await GET(getRequest('?page=3&limit=500'))
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 200, take: 100 }))
  })

  it('falls back to defaults for invalid pagination', async () => {
    await GET(getRequest('?page=abc&limit=-4'))
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }))
  })

  it('returns 401 without a token', async () => {
    const res = await GET(getRequest('', {}))
    expect(res.status).toBe(401)
    expect(prisma.contact.findMany).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid or the user is unknown', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValueOnce(null as never)
    expect((await GET(getRequest())).status).toBe(401)

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null as never)
    expect((await GET(getRequest())).status).toBe(401)
  })

  it('returns 500 when the query fails', async () => {
    vi.mocked(prisma.contact.findMany).mockRejectedValueOnce(new Error('db down'))
    const res = await GET(getRequest())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to fetch contacts' })
  })
})

describe('POST /api/contacts', () => {
  it('creates a contact scoped to the caller with a normalized email', async () => {
    const res = await POST(
      postRequest({ name: '  Ada Lovelace ', email: '  ADA@Example.com ', phone: ' 555 ', company: 'Analytical' }),
    )

    expect(res.status).toBe(201)
    expect((await res.json()).contact.id).toBe('contact-1')
    expect(prisma.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          userId: 'user-1',
          email: 'ada@example.com',
          name: 'Ada Lovelace',
          phone: '555',
          company: 'Analytical',
          notes: null,
        },
      }),
    )
  })

  it('checks uniqueness for this user and email only', async () => {
    await POST(postRequest({ name: 'Ada', email: 'ada@example.com' }))
    expect(prisma.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', email: 'ada@example.com' } }),
    )
  })

  it('returns 409 when an active contact already uses the email', async () => {
    vi.mocked(prisma.contact.findFirst).mockResolvedValueOnce({ id: 'c-9', deletedAt: null } as never)

    const res = await POST(postRequest({ name: 'Ada', email: 'ada@example.com' }))

    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already exists/)
    expect(prisma.contact.create).not.toHaveBeenCalled()
    expect(prisma.contact.update).not.toHaveBeenCalled()
  })

  it('lets a soft-deleted contact\'s email be reused by restoring that row with the new details', async () => {
    vi.mocked(prisma.contact.findFirst).mockResolvedValueOnce({
      id: 'c-old',
      deletedAt: new Date('2026-02-01T00:00:00Z'),
    } as never)

    const res = await POST(postRequest({ name: 'New Ada', email: 'ada@example.com', notes: 'back again' }))

    expect(res.status).toBe(201)
    expect(prisma.contact.create).not.toHaveBeenCalled()
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c-old' },
        data: { name: 'New Ada', phone: null, company: null, notes: 'back again', deletedAt: null },
      }),
    )
  })

  it('returns a clean 409 (not a 500) when a concurrent insert wins the unique constraint', async () => {
    vi.mocked(prisma.contact.create).mockRejectedValueOnce(uniqueError())

    const res = await POST(postRequest({ name: 'Ada', email: 'ada@example.com' }))

    expect(res.status).toBe(409)
  })

  it.each([
    ['missing name', { email: 'a@b.co' }, 'name is required'],
    ['blank name', { name: '   ', email: 'a@b.co' }, 'name is required'],
    ['missing email', { name: 'Ada' }, 'email is required'],
    ['malformed email', { name: 'Ada', email: 'not-an-email' }, 'valid email'],
    ['email without domain dot', { name: 'Ada', email: 'a@b' }, 'valid email'],
    ['email with spaces', { name: 'Ada', email: 'a b@c.co' }, 'valid email'],
    ['non-string email', { name: 'Ada', email: 42 }, 'email is required'],
    ['too-long name', { name: 'x'.repeat(256), email: 'a@b.co' }, 'name must be at most 255'],
    ['too-long email', { name: 'Ada', email: `${'x'.repeat(251)}@b.co` }, 'email must be at most 255'],
    ['too-long phone', { name: 'Ada', email: 'a@b.co', phone: '1'.repeat(21) }, 'phone must be at most 20'],
    ['too-long company', { name: 'Ada', email: 'a@b.co', company: 'c'.repeat(101) }, 'company must be at most 100'],
    ['too-long notes', { name: 'Ada', email: 'a@b.co', notes: 'n'.repeat(1001) }, 'notes must be at most 1000'],
    ['non-string phone', { name: 'Ada', email: 'a@b.co', phone: 123 }, 'phone must be a string'],
  ])('rejects %s with 400 before touching the database', async (_label, body, message) => {
    const res = await POST(postRequest(body))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain(message)
    expect(prisma.contact.findFirst).not.toHaveBeenCalled()
    expect(prisma.contact.create).not.toHaveBeenCalled()
  })

  it('rejects invalid and non-object JSON bodies', async () => {
    expect((await POST(postRequest('{not json'))).status).toBe(400)
    expect((await POST(postRequest('[]'))).status).toBe(400)
    expect((await POST(postRequest('null'))).status).toBe(400)
  })

  it('returns 401 without authentication', async () => {
    const res = await POST(postRequest({ name: 'Ada', email: 'a@b.co' }, {}))
    expect(res.status).toBe(401)
    expect(prisma.contact.create).not.toHaveBeenCalled()
  })

  it('returns 500 for unexpected database errors', async () => {
    vi.mocked(prisma.contact.create).mockRejectedValueOnce(new Error('connection lost'))
    const res = await POST(postRequest({ name: 'Ada', email: 'ada@example.com' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create contact' })
  })
})
