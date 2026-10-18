import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockClientNoteFindMany = vi.fn()
const mockClientNoteFindFirst = vi.fn()
const mockClientNoteCount = vi.fn()
const mockClientNoteCreate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    clientNote: {
      findMany: (...args: unknown[]) => mockClientNoteFindMany(...args),
      findFirst: (...args: unknown[]) => mockClientNoteFindFirst(...args),
      count: (...args: unknown[]) => mockClientNoteCount(...args),
      create: (...args: unknown[]) => mockClientNoteCreate(...args),
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

import { GET, POST } from './route'

function makeRequest(
  url: string,
  options?: {
    method?: string
    token?: string
    headers?: Record<string, string>
    body?: unknown
  },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options?.headers ?? {}),
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'GET',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Client Private Notes API (/api/clients/[id]/notes)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'freelancer-1' })
    mockUserFindUnique.mockImplementation(async ({ where }: any) => {
      if (where.privyId === 'freelancer-1' || where.id === 'freelancer-1') {
        return { id: 'freelancer-1', privyId: 'freelancer-1', role: 'user' }
      }
      if (where.id === 'client-1') {
        return { id: 'client-1', ownerId: 'freelancer-1', role: 'user' }
      }
      return null
    })
    mockClientNoteFindFirst.mockResolvedValue(null)
  })

  it('rejects client-facing portal tokens or the client themselves from viewing private notes (403)', async () => {
    const reqPortal = makeRequest(
      'http://localhost/api/clients/client-1/notes',
      {
        method: 'GET',
        token: 'cps_1234567890abcdef',
      },
    )
    const resPortal = await GET(reqPortal, { params: { id: 'client-1' } })
    expect(resPortal.status).toBe(403)
    const jsonPortal = await resPortal.json()
    expect(jsonPortal.code).toBe('CLIENT_PORTAL_FORBIDDEN')

    // Also reject if the authenticated user is the client themselves
    mockVerifyAuthToken.mockResolvedValueOnce({ userId: 'client-1' })
    mockUserFindUnique.mockResolvedValueOnce({
      id: 'client-1',
      privyId: 'client-1',
    })
    const reqSelf = makeRequest('http://localhost/api/clients/client-1/notes', {
      method: 'GET',
      token: 'client-jwt',
    })
    const resSelf = await GET(reqSelf, { params: { id: 'client-1' } })
    expect(resSelf.status).toBe(403)
  })

  it('restricts access strictly to the user who owns the client relationship (403)', async () => {
    mockVerifyAuthToken.mockResolvedValue({ userId: 'other-freelancer' })
    mockUserFindUnique.mockImplementation(async ({ where }: any) => {
      if (
        where.privyId === 'other-freelancer' ||
        where.id === 'other-freelancer'
      ) {
        return { id: 'other-freelancer', privyId: 'other-freelancer' }
      }
      if (where.id === 'client-1') {
        return { id: 'client-1', ownerId: 'freelancer-1' }
      }
      return null
    })

    const reqGet = makeRequest('http://localhost/api/clients/client-1/notes', {
      method: 'GET',
      token: 'other-token',
    })
    const resGet = await GET(reqGet, { params: { id: 'client-1' } })
    expect(resGet.status).toBe(403)

    const reqPost = makeRequest('http://localhost/api/clients/client-1/notes', {
      method: 'POST',
      token: 'other-token',
      body: { content: 'Unauthorized note' },
    })
    const resPost = await POST(reqPost, { params: { id: 'client-1' } })
    expect(resPost.status).toBe(403)
    expect(mockClientNoteCreate).not.toHaveBeenCalled()
  })

  it('supports pagination ordered by createdAt descending on GET and creates notes on POST', async () => {
    const t1 = new Date('2026-04-01T10:00:00Z')
    const t2 = new Date('2026-04-02T10:00:00Z')

    mockClientNoteFindMany.mockResolvedValue([
      {
        id: 'note-2',
        userId: 'freelancer-1',
        clientId: 'client-1',
        content: 'Prefers net-15 invoicing',
        createdAt: t2,
        updatedAt: t2,
      },
      {
        id: 'note-1',
        userId: 'freelancer-1',
        clientId: 'client-1',
        content: 'Initial onboarding call completed',
        createdAt: t1,
        updatedAt: t1,
      },
    ])
    mockClientNoteCount.mockResolvedValue(5)

    const reqGet = makeRequest(
      'http://localhost/api/clients/client-1/notes?page=2&limit=2',
      {
        method: 'GET',
        token: 'valid-token',
      },
    )

    const resGet = await GET(reqGet, { params: { id: 'client-1' } })
    expect(resGet.status).toBe(200)
    const jsonGet = await resGet.json()
    expect(jsonGet.notes.map((n: any) => n.id)).toEqual(['note-2', 'note-1'])
    expect(jsonGet.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 5,
      totalPages: 3,
    })
    expect(mockClientNoteFindMany).toHaveBeenCalledWith({
      where: { userId: 'freelancer-1', clientId: 'client-1' },
      orderBy: { createdAt: 'desc' },
      skip: 2,
      take: 2,
    })

    // Create a new note via POST
    mockClientNoteCreate.mockImplementation(async ({ data }: any) => ({
      id: 'note-3',
      ...data,
      createdAt: t2,
      updatedAt: t2,
    }))

    const reqPost = makeRequest('http://localhost/api/clients/client-1/notes', {
      method: 'POST',
      token: 'valid-token',
      body: { content: '  Approved Q2 retainer renewal  ' },
    })

    const resPost = await POST(reqPost, { params: { id: 'client-1' } })
    expect(resPost.status).toBe(201)
    const jsonPost = await resPost.json()
    expect(jsonPost.note.id).toBe('note-3')
    expect(jsonPost.note.content).toBe('Approved Q2 retainer renewal')
    expect(jsonPost.note.userId).toBe('freelancer-1')
    expect(jsonPost.note.clientId).toBe('client-1')
  })
})
