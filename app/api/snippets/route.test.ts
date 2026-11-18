import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    snippet: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  }
  return { prisma }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET, POST, DELETE } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const NOW = new Date('2026-11-18T12:00:00.000Z')

function makeRequest(method: 'GET' | 'POST' | 'DELETE', body?: string, headers: Record<string, string> = { authorization: 'Bearer token' }, url = 'http://localhost/api/snippets') {
  return new NextRequest(url, { method, headers, body })
}

function mockSnippet(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snippet-1',
    title: 'Invoice intro',
    content: 'Thank you for your business',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
})

describe('GET /api/snippets', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await GET(makeRequest('GET', undefined, {}))
    expect(res.status).toBe(401)
    expect(prisma.snippet.findMany).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
    expect(prisma.snippet.findMany).not.toHaveBeenCalled()
  })

  it('returns an empty list when the user has no snippets', async () => {
    vi.mocked(prisma.snippet.findMany).mockResolvedValue([])
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ snippets: [] })
  })

  it('returns all snippets for the authenticated user ordered by updatedAt descending', async () => {
    const snippet1 = mockSnippet({ id: 'snippet-1', updatedAt: new Date('2026-11-18T10:00:00.000Z') })
    const snippet2 = mockSnippet({ id: 'snippet-2', title: 'Payment terms', updatedAt: new Date('2026-11-18T12:00:00.000Z') })
    vi.mocked(prisma.snippet.findMany).mockResolvedValue([snippet2, snippet1] as never)

    const res = await GET(makeRequest('GET'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.snippets).toHaveLength(2)
    expect(body.snippets[0].id).toBe('snippet-2')
    expect(body.snippets[1].id).toBe('snippet-1')

    expect(prisma.snippet.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { id: true, title: true, content: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    })
  })

  it('filters snippets by title search (case-insensitive)', async () => {
    const snippet = mockSnippet({ title: 'Invoice intro' })
    vi.mocked(prisma.snippet.findMany).mockResolvedValue([snippet] as never)

    const res = await GET(makeRequest('GET', undefined, {}, 'http://localhost/api/snippets?search=invoice'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.snippets).toHaveLength(1)

    expect(prisma.snippet.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        title: { contains: 'invoice', mode: 'insensitive' },
      },
      select: { id: true, title: true, content: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    })
  })

  it('ignores whitespace-only search queries', async () => {
    vi.mocked(prisma.snippet.findMany).mockResolvedValue([])

    const res = await GET(makeRequest('GET', undefined, {}, 'http://localhost/api/snippets?search=   '))

    expect(prisma.snippet.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { id: true, title: true, content: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    })
  })

  it('returns a generic 500 on database error', async () => {
    vi.mocked(prisma.snippet.findMany).mockRejectedValue(new Error('connection refused'))
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to fetch snippets' })
  })
})

describe('POST /api/snippets', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ title: 'Test', content: 'Content' }), {}))
    expect(res.status).toBe(401)
    expect(prisma.snippet.create).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makeRequest('POST', JSON.stringify({ title: 'Test', content: 'Content' })))
    expect(res.status).toBe(401)
    expect(prisma.snippet.create).not.toHaveBeenCalled()
  })

  it('creates a snippet with valid title and content', async () => {
    const snippet = mockSnippet()
    vi.mocked(prisma.snippet.create).mockResolvedValue(snippet as never)

    const res = await POST(makeRequest('POST', JSON.stringify({ title: 'Invoice intro', content: 'Thank you for your business' })))
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.snippet).toEqual(snippet)

    expect(prisma.snippet.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        title: 'Invoice intro',
        content: 'Thank you for your business',
      },
      select: { id: true, title: true, content: true, createdAt: true, updatedAt: true },
    })
  })

  it('trims whitespace from title and content', async () => {
    const snippet = mockSnippet({ title: 'Invoice intro', content: 'Thank you' })
    vi.mocked(prisma.snippet.create).mockResolvedValue(snippet as never)

    const res = await POST(makeRequest('POST', JSON.stringify({ title: '  Invoice intro  ', content: '  Thank you  ' })))

    expect(res.status).toBe(201)
    expect(prisma.snippet.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        title: 'Invoice intro',
        content: 'Thank you',
      },
      select: expect.any(Object),
    })
  })

  it('rejects malformed JSON', async () => {
    const res = await POST(makeRequest('POST', '{not json'))
    expect(res.status).toBe(400)
    expect(prisma.snippet.create).not.toHaveBeenCalled()
  })

  it('rejects an empty body', async () => {
    const res = await POST(makeRequest('POST', ''))
    expect(res.status).toBe(400)
    expect(prisma.snippet.create).not.toHaveBeenCalled()
  })

  it('rejects a request with missing title', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ content: 'Some content' })))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.details).toBeDefined()
    expect(prisma.snippet.create).not.toHaveBeenCalled()
  })

  it('rejects a request with missing content', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ title: 'Some title' })))
    expect(res.status).toBe(400)
    expect(prisma.snippet.create).not.toHaveBeenCalled()
  })

  it('rejects an empty title', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ title: '   ', content: 'Valid content' })))
    expect(res.status).toBe(400)
    expect(prisma.snippet.create).not.toHaveBeenCalled()
  })

  it('rejects an empty content', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ title: 'Valid title', content: '   ' })))
    expect(res.status).toBe(400)
    expect(prisma.snippet.create).not.toHaveBeenCalled()
  })

  it('rejects a title longer than 150 characters', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ title: 'x'.repeat(151), content: 'Valid content' })))
    expect(res.status).toBe(400)
    expect(prisma.snippet.create).not.toHaveBeenCalled()
  })

  it('rejects unknown fields such as client-supplied userId', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ title: 'Test', content: 'Content', userId: 'someone-else' })))
    expect(res.status).toBe(400)
    expect(prisma.snippet.create).not.toHaveBeenCalled()
  })

  it('returns a generic 500 on database error', async () => {
    vi.mocked(prisma.snippet.create).mockRejectedValue(new Error('connection refused'))
    const res = await POST(makeRequest('POST', JSON.stringify({ title: 'Test', content: 'Content' })))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create snippet' })
  })
})

describe('DELETE /api/snippets', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await DELETE(makeRequest('DELETE', undefined, {}))
    expect(res.status).toBe(401)
    expect(prisma.snippet.delete).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/snippets?id=snippet-1'))
    expect(res.status).toBe(401)
    expect(prisma.snippet.delete).not.toHaveBeenCalled()
  })

  it('returns 400 when snippet ID is missing', async () => {
    const res = await DELETE(makeRequest('DELETE'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Snippet ID is required' })
    expect(prisma.snippet.delete).not.toHaveBeenCalled()
  })

  it('returns 404 when snippet does not exist', async () => {
    vi.mocked(prisma.snippet.findUnique).mockResolvedValue(null)
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/snippets?id=nonexistent'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Snippet not found' })
    expect(prisma.snippet.delete).not.toHaveBeenCalled()
  })

  it('returns 403 when the snippet belongs to a different user', async () => {
    vi.mocked(prisma.snippet.findUnique).mockResolvedValue({ userId: 'other-user' } as never)
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/snippets?id=snippet-1'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(prisma.snippet.delete).not.toHaveBeenCalled()
  })

  it('deletes a snippet owned by the authenticated user', async () => {
    vi.mocked(prisma.snippet.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.snippet.delete).mockResolvedValue(mockSnippet() as never)

    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/snippets?id=snippet-1'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    expect(prisma.snippet.findUnique).toHaveBeenCalledWith({
      where: { id: 'snippet-1' },
      select: { userId: true },
    })
    expect(prisma.snippet.delete).toHaveBeenCalledWith({
      where: { id: 'snippet-1' },
    })
  })

  it('ignores whitespace in the ID parameter', async () => {
    vi.mocked(prisma.snippet.findUnique).mockResolvedValue({ userId: 'user-1' } as never)
    vi.mocked(prisma.snippet.delete).mockResolvedValue(mockSnippet() as never)

    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/snippets?id=  snippet-1  '))

    expect(res.status).toBe(200)
    expect(prisma.snippet.findUnique).toHaveBeenCalledWith({
      where: { id: 'snippet-1' },
      select: { userId: true },
    })
  })

  it('returns a generic 500 on database error', async () => {
    vi.mocked(prisma.snippet.findUnique).mockRejectedValue(new Error('connection refused'))
    const res = await DELETE(makeRequest('DELETE', undefined, {}, 'http://localhost/api/snippets?id=snippet-1'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to delete snippet' })
  })
})
