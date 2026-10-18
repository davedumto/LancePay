import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockTagFindUnique = vi.fn()
const mockTagFindMany = vi.fn()
const mockTagCreate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    tag: {
      findUnique: (...args: unknown[]) => mockTagFindUnique(...args),
      findMany: (...args: unknown[]) => mockTagFindMany(...args),
      create: (...args: unknown[]) => mockTagCreate(...args),
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

import { GET, POST, DEFAULT_TAG_COLOR } from './route'

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

describe('Tags API (/api/tags)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
    mockTagFindUnique.mockResolvedValue(null)
  })

  it('enforces the unique (userId, name) constraint with a clean 409 on collision', async () => {
    mockTagFindUnique.mockResolvedValue({
      id: 'tag-existing',
      userId: 'user-1',
      name: 'Retainer',
      color: '#6366f1',
    })

    const req = makeRequest('http://localhost/api/tags', {
      token: 'valid-token',
      body: { name: 'Retainer', color: '#10b981' },
    })

    const res = await POST(req)
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('TAG_NAME_ALREADY_EXISTS')
    expect(mockTagCreate).not.toHaveBeenCalled()
  })

  it('validates color is a valid 7-character hex code matching the schema format', async () => {
    const reqInvalidShort = makeRequest('http://localhost/api/tags', {
      token: 'valid-token',
      body: { name: 'Urgent', color: '#fff' },
    })
    const resShort = await POST(reqInvalidShort)
    expect(resShort.status).toBe(400)
    const jsonShort = await resShort.json()
    expect(jsonShort.code).toBe('INVALID_TAG_COLOR')

    const reqInvalidChars = makeRequest('http://localhost/api/tags', {
      token: 'valid-token',
      body: { name: 'Urgent', color: '#GGGGGG' },
    })
    const resChars = await POST(reqInvalidChars)
    expect(resChars.status).toBe(400)
    expect(mockTagCreate).not.toHaveBeenCalled()

    // Valid 7-char hex code succeeds, and omitting color defaults to #6366f1
    mockTagCreate.mockImplementation(async ({ data }: any) => ({
      id: 'tag-new',
      ...data,
      createdAt: new Date('2026-04-01T10:00:00Z'),
    }))

    const reqValid = makeRequest('http://localhost/api/tags', {
      token: 'valid-token',
      body: { name: 'Urgent', color: '#EF4444' },
    })
    const resValid = await POST(reqValid)
    expect(resValid.status).toBe(201)
    const jsonValid = await resValid.json()
    expect(jsonValid.tag.color).toBe('#ef4444')

    const reqDefaultColor = makeRequest('http://localhost/api/tags', {
      token: 'valid-token',
      body: { name: 'Standard' },
    })
    const resDefault = await POST(reqDefaultColor)
    expect(resDefault.status).toBe(201)
    const jsonDefault = await resDefault.json()
    expect(jsonDefault.tag.color).toBe(DEFAULT_TAG_COLOR)
  })

  it('returns the full tag list sorted by name ascending on GET', async () => {
    const now = new Date('2026-04-01T10:00:00Z')
    mockTagFindMany.mockResolvedValue([
      {
        id: 'tag-z',
        userId: 'user-1',
        name: 'Zero-rate',
        color: '#6366f1',
        createdAt: now,
      },
      {
        id: 'tag-a',
        userId: 'user-1',
        name: 'Advisory',
        color: '#10b981',
        createdAt: now,
      },
      {
        id: 'tag-m',
        userId: 'user-1',
        name: 'Milestone',
        color: '#f59e0b',
        createdAt: now,
      },
    ])

    const req = makeRequest('http://localhost/api/tags', {
      method: 'GET',
      token: 'valid-token',
    })

    const res = await GET(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tags.map((t: any) => t.name)).toEqual([
      'Advisory',
      'Milestone',
      'Zero-rate',
    ])
    expect(mockTagFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { name: 'asc' },
    })
  })
})
