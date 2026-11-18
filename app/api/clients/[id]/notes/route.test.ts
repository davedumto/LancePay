import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    clientNote: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    invoice: { count: vi.fn() },
  }
  return { prisma }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const NOW = new Date('2026-11-18T12:00:00.000Z')

function makeRequest(method: 'GET' | 'POST', body?: string, headers: Record<string, string> = { authorization: 'Bearer token' }, url = 'http://localhost/api/clients/client-1/notes') {
  return new NextRequest(url, { method, headers, body })
}

function mockNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    content: 'Pays promptly',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
  vi.mocked(prisma.clientNote.count).mockResolvedValue(0)
  vi.mocked(prisma.invoice.count).mockResolvedValue(1)
})

describe('GET /api/clients/[id]/notes', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await GET(makeRequest('GET', undefined, {}), { params: { id: 'client-1' } })
    expect(res.status).toBe(401)
    expect(prisma.clientNote.findMany).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params: { id: 'client-1' } })
    expect(res.status).toBe(401)
    expect(prisma.clientNote.findMany).not.toHaveBeenCalled()
  })

  it('returns 400 when client ID is missing', async () => {
    const res = await GET(makeRequest('GET'), { params: { id: '' } })
    expect(res.status).toBe(400)
    expect(prisma.clientNote.findMany).not.toHaveBeenCalled()
  })

  it('returns 404 when the client does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null)
    const res = await GET(makeRequest('GET'), { params: { id: 'nonexistent' } })
    expect(res.status).toBe(404)
  })

  it('returns 403 when the user has no relationship with the client', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    vi.mocked(prisma.clientNote.count).mockResolvedValueOnce(0)
    vi.mocked(prisma.invoice.count).mockResolvedValueOnce(0)

    const res = await GET(makeRequest('GET'), { params: { id: 'client-1' } })
    expect(res.status).toBe(403)
    expect(prisma.clientNote.findMany).not.toHaveBeenCalled()
  })

  it('returns an empty list when the client has no notes', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    vi.mocked(prisma.clientNote.findMany).mockResolvedValue([])
    vi.mocked(prisma.clientNote.count).mockResolvedValueOnce(0)

    const res = await GET(makeRequest('GET'), { params: { id: 'client-1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.notes).toEqual([])
    expect(body.pagination).toEqual({ page: 1, limit: 50, total: 0, pages: 0 })
  })

  it('returns notes paginated with default page=1 and limit=50', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    const note1 = mockNote({ id: 'note-1' })
    const note2 = mockNote({ id: 'note-2', createdAt: new Date('2026-11-17T12:00:00.000Z') })
    vi.mocked(prisma.clientNote.findMany).mockResolvedValue([note1, note2] as never)
    vi.mocked(prisma.clientNote.count).mockResolvedValueOnce(2)

    const res = await GET(makeRequest('GET'), { params: { id: 'client-1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.notes).toHaveLength(2)
    expect(body.pagination).toEqual({ page: 1, limit: 50, total: 2, pages: 1 })

    expect(prisma.clientNote.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', clientId: 'client-1' },
      select: { id: true, content: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 50,
    })
  })

  it('supports custom pagination parameters', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    const note = mockNote()
    vi.mocked(prisma.clientNote.findMany).mockResolvedValue([note] as never)
    vi.mocked(prisma.clientNote.count).mockResolvedValueOnce(25)

    const res = await GET(makeRequest('GET', undefined, {}, 'http://localhost/api/clients/client-1/notes?page=2&limit=10'), { params: { id: 'client-1' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.pagination).toEqual({ page: 2, limit: 10, total: 25, pages: 3 })

    expect(prisma.clientNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
      }),
    )
  })

  it('caps limit at 100', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    vi.mocked(prisma.clientNote.findMany).mockResolvedValue([])
    vi.mocked(prisma.clientNote.count).mockResolvedValueOnce(0)

    const res = await GET(makeRequest('GET', undefined, {}, 'http://localhost/api/clients/client-1/notes?limit=200'), { params: { id: 'client-1' } })
    const body = await res.json()

    expect(body.pagination.limit).toBe(100)
  })

  it('rejects invalid pagination parameters', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)

    const res = await GET(makeRequest('GET', undefined, {}, 'http://localhost/api/clients/client-1/notes?page=invalid'), { params: { id: 'client-1' } })
    expect(res.status).toBe(400)
    expect(prisma.clientNote.findMany).not.toHaveBeenCalled()
  })

  it('allows access if user has existing notes for the client', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    vi.mocked(prisma.clientNote.count).mockResolvedValueOnce(2)
    vi.mocked(prisma.clientNote.findMany).mockResolvedValue([])
    vi.mocked(prisma.clientNote.count).mockResolvedValueOnce(2)

    const res = await GET(makeRequest('GET'), { params: { id: 'client-1' } })

    expect(res.status).toBe(200)
    expect(prisma.clientNote.findMany).toHaveBeenCalled()
    // Should not check invoices if notes exist
    expect(prisma.invoice.count).not.toHaveBeenCalled()
  })

  it('returns a generic 500 on database error', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    vi.mocked(prisma.clientNote.count).mockRejectedValueOnce(new Error('connection refused'))

    const res = await GET(makeRequest('GET'), { params: { id: 'client-1' } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to fetch notes' })
  })
})

describe('POST /api/clients/[id]/notes', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ content: 'Note' }), {}), { params: { id: 'client-1' } })
    expect(res.status).toBe(401)
    expect(prisma.clientNote.create).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makeRequest('POST', JSON.stringify({ content: 'Note' })), { params: { id: 'client-1' } })
    expect(res.status).toBe(401)
    expect(prisma.clientNote.create).not.toHaveBeenCalled()
  })

  it('returns 400 when client ID is missing', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ content: 'Note' })), { params: { id: '' } })
    expect(res.status).toBe(400)
    expect(prisma.clientNote.create).not.toHaveBeenCalled()
  })

  it('returns 404 when the client does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null)
    const res = await POST(makeRequest('POST', JSON.stringify({ content: 'Note' })), { params: { id: 'nonexistent' } })
    expect(res.status).toBe(404)
    expect(prisma.clientNote.create).not.toHaveBeenCalled()
  })

  it('returns 403 when the user has no invoice relationship with the client', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    vi.mocked(prisma.invoice.count).mockResolvedValueOnce(0)

    const res = await POST(makeRequest('POST', JSON.stringify({ content: 'Note' })), { params: { id: 'client-1' } })
    expect(res.status).toBe(403)
    expect(prisma.clientNote.create).not.toHaveBeenCalled()
  })

  it('creates a note with valid content', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    const note = mockNote()
    vi.mocked(prisma.clientNote.create).mockResolvedValue(note as never)

    const res = await POST(makeRequest('POST', JSON.stringify({ content: 'Pays promptly' })), { params: { id: 'client-1' } })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.note).toEqual(note)

    expect(prisma.clientNote.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        clientId: 'client-1',
        content: 'Pays promptly',
      },
      select: { id: true, content: true, createdAt: true, updatedAt: true },
    })
  })

  it('trims whitespace from content', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    const note = mockNote()
    vi.mocked(prisma.clientNote.create).mockResolvedValue(note as never)

    const res = await POST(makeRequest('POST', JSON.stringify({ content: '  Pays promptly  ' })), { params: { id: 'client-1' } })

    expect(res.status).toBe(201)
    expect(prisma.clientNote.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        clientId: 'client-1',
        content: 'Pays promptly',
      },
      select: expect.any(Object),
    })
  })

  it('rejects malformed JSON', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)

    const res = await POST(makeRequest('POST', '{not json'), { params: { id: 'client-1' } })
    expect(res.status).toBe(400)
    expect(prisma.clientNote.create).not.toHaveBeenCalled()
  })

  it('rejects an empty body', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)

    const res = await POST(makeRequest('POST', ''), { params: { id: 'client-1' } })
    expect(res.status).toBe(400)
    expect(prisma.clientNote.create).not.toHaveBeenCalled()
  })

  it('rejects a request with missing content', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)

    const res = await POST(makeRequest('POST', JSON.stringify({})), { params: { id: 'client-1' } })
    expect(res.status).toBe(400)
    expect(prisma.clientNote.create).not.toHaveBeenCalled()
  })

  it('rejects an empty content string', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)

    const res = await POST(makeRequest('POST', JSON.stringify({ content: '   ' })), { params: { id: 'client-1' } })
    expect(res.status).toBe(400)
    expect(prisma.clientNote.create).not.toHaveBeenCalled()
  })

  it('rejects unknown fields such as client-supplied userId', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)

    const res = await POST(makeRequest('POST', JSON.stringify({ content: 'Note', userId: 'someone-else' })), { params: { id: 'client-1' } })
    expect(res.status).toBe(400)
    expect(prisma.clientNote.create).not.toHaveBeenCalled()
  })

  it('returns a generic 500 on database error', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'client-1' } as never)
    vi.mocked(prisma.clientNote.create).mockRejectedValue(new Error('connection refused'))

    const res = await POST(makeRequest('POST', JSON.stringify({ content: 'Note' })), { params: { id: 'client-1' } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create note' })
  })
})
