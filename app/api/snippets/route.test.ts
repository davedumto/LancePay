import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockSnippetFindMany = vi.fn()
const mockSnippetFindUnique = vi.fn()
const mockSnippetCreate = vi.fn()
const mockSnippetDelete = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    snippet: {
      findMany: (...args: unknown[]) => mockSnippetFindMany(...args),
      findUnique: (...args: unknown[]) => mockSnippetFindUnique(...args),
      create: (...args: unknown[]) => mockSnippetCreate(...args),
      delete: (...args: unknown[]) => mockSnippetDelete(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { GET, POST, DELETE } from './route'

function makeRequest(
  url: string,
  options?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Snippets API (/api/snippets)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
  })

  it('validates that title and content are non-empty on POST', async () => {
    const reqEmptyTitle = makeRequest('http://localhost/api/snippets', {
      token: 'valid-token',
      body: { title: '   ', content: 'Payment due within 14 days' },
    })
    const resEmptyTitle = await POST(reqEmptyTitle)
    expect(resEmptyTitle.status).toBe(400)
    const jsonTitle = await resEmptyTitle.json()
    expect(jsonTitle.code).toBe('TITLE_REQUIRED')

    const reqEmptyContent = makeRequest('http://localhost/api/snippets', {
      token: 'valid-token',
      body: { title: 'Net 14 Terms', content: '   ' },
    })
    const resEmptyContent = await POST(reqEmptyContent)
    expect(resEmptyContent.status).toBe(400)
    const jsonContent = await resEmptyContent.json()
    expect(jsonContent.code).toBe('CONTENT_REQUIRED')

    expect(mockSnippetCreate).not.toHaveBeenCalled()
  })

  it('creates a snippet scoped to the authenticated user', async () => {
    const now = new Date('2026-04-01T10:00:00Z')
    mockSnippetCreate.mockImplementation(async ({ data }: any) => ({
      id: 'snip-1',
      ...data,
      createdAt: now,
      updatedAt: now,
    }))

    const req = makeRequest('http://localhost/api/snippets', {
      token: 'valid-token',
      body: {
        title: 'Standard Retainer Description',
        content: 'Monthly software engineering retainer services.',
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.snippet.id).toBe('snip-1')
    expect(json.snippet.userId).toBe('user-1')
    expect(json.snippet.title).toBe('Standard Retainer Description')
  })

  it('supports optional search query parameter on GET to filter by title and scopes to the authenticated user', async () => {
    const now = new Date('2026-04-01T10:00:00Z')
    mockSnippetFindMany.mockResolvedValue([
      {
        id: 'snip-1',
        userId: 'user-1',
        title: 'Frontend Milestone',
        content: 'React UI implementation',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'snip-2',
        userId: 'user-1',
        title: 'Backend Audit',
        content: 'API security review',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'snip-other-user',
        userId: 'user-2',
        title: 'Frontend Other',
        content: 'Should not leak',
        createdAt: now,
        updatedAt: now,
      },
    ])

    const req = makeRequest(
      'http://localhost/api/snippets?search=frontend',
      {
        method: 'GET',
        token: 'valid-token',
      },
    )

    const res = await GET(req)
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.total).toBe(1)
    expect(json.snippets[0].id).toBe('snip-1')
    expect(mockSnippetFindMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        title: {
          contains: 'frontend',
          mode: 'insensitive',
        },
      },
      orderBy: { updatedAt: 'desc' },
    })
  })

  it('scopes DELETE strictly to the authenticated user (403 on other user snippet, 200 on own snippet)', async () => {
    mockSnippetFindUnique.mockResolvedValueOnce({
      id: 'snip-other',
      userId: 'user-2',
      title: 'Other user',
      content: 'Private',
    })

    const reqForbidden = makeRequest(
      'http://localhost/api/snippets?id=snip-other',
      {
        method: 'DELETE',
        token: 'valid-token',
      },
    )
    const resForbidden = await DELETE(reqForbidden)
    expect(resForbidden.status).toBe(403)
    expect(mockSnippetDelete).not.toHaveBeenCalled()

    mockSnippetFindUnique.mockResolvedValueOnce({
      id: 'snip-own',
      userId: 'user-1',
      title: 'Own snippet',
      content: 'Mine',
    })
    mockSnippetDelete.mockResolvedValueOnce({ id: 'snip-own' })

    const reqOwn = makeRequest('http://localhost/api/snippets?id=snip-own', {
      method: 'DELETE',
      token: 'valid-token',
    })
    const resOwn = await DELETE(reqOwn)
    expect(resOwn.status).toBe(200)
    const jsonOwn = await resOwn.json()
    expect(jsonOwn.deleted).toBe(true)
    expect(mockSnippetDelete).toHaveBeenCalledWith({
      where: { id: 'snip-own' },
    })
  })
})
