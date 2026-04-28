import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from '../route'
import { buildRequest, makeTag, makeUser } from '../../_lib/test-helpers'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    tag: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerifyAuthToken = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedTagFindMany = vi.mocked(prisma.tag.findMany)
const mockedTagFindUnique = vi.mocked(prisma.tag.findUnique)
const mockedTagCreate = vi.mocked(prisma.tag.create)

describe('GET /api/routes-b/tags', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser() as never)
  })

  it('returns empty list', async () => {
    mockedTagFindMany.mockResolvedValue([] as never)
    const request = buildRequest('GET', 'http://localhost/api/routes-b/tags', { token: 'token' })
    const response = await GET(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ tags: [] })
  })

  it('returns populated list', async () => {
    mockedTagFindMany.mockResolvedValue(
      [makeTag({ id: 'tag-1', name: 'Alpha', invoiceCount: 1 }), makeTag({ id: 'tag-2', name: 'Beta', invoiceCount: 3 })] as never,
    )
    const request = buildRequest('GET', 'http://localhost/api/routes-b/tags', { token: 'token' })
    const response = await GET(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.tags).toHaveLength(2)
    expect(body.tags[0]).toMatchObject({ id: 'tag-1', name: 'Alpha', invoiceCount: 1 })
    expect(body.tags[1]).toMatchObject({ id: 'tag-2', name: 'Beta', invoiceCount: 3 })
  })

  it('queries tags ordered by name', async () => {
    mockedTagFindMany.mockResolvedValue([] as never)
    const request = buildRequest('GET', 'http://localhost/api/routes-b/tags', { token: 'token' })
    await GET(request)

    expect(mockedTagFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { name: 'asc' },
      }),
    )
  })
})

describe('POST /api/routes-b/tags', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser() as never)
  })

  it('creates a tag when payload is valid', async () => {
    mockedTagFindUnique.mockResolvedValue(null as never)
    mockedTagCreate.mockResolvedValue(makeTag({ id: 'tag-new', name: 'Urgent' }) as never)
    const request = buildRequest('POST', 'http://localhost/api/routes-b/tags', {
      token: 'token',
      body: { name: 'Urgent', color: '#123456' },
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body).toEqual({
      id: 'tag-new',
      name: 'Urgent',
      color: '#123456',
      invoiceCount: 0,
    })
  })

  it('returns conflict for duplicate name', async () => {
    mockedTagFindUnique.mockResolvedValue(makeTag({ id: 'tag-existing', name: 'Urgent' }) as never)
    const request = buildRequest('POST', 'http://localhost/api/routes-b/tags', {
      token: 'token',
      body: { name: 'Urgent' },
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toEqual({ error: 'Tag with this name already exists' })
    expect(mockedTagCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when name is missing', async () => {
    const request = buildRequest('POST', 'http://localhost/api/routes-b/tags', {
      token: 'token',
      body: { color: '#abcdef' },
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({ error: 'Tag name is required' })
  })

  it('returns 400 when name is oversized', async () => {
    const request = buildRequest('POST', 'http://localhost/api/routes-b/tags', {
      token: 'token',
      body: { name: 'x'.repeat(51) },
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({ error: 'Tag name must be at most 50 characters' })
  })
})

