import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    project: { findMany: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const projectDelegate = prisma.project as unknown as {
  findMany: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}

const BASE_URL = 'http://localhost/api/routes-b/projects'

function makeGet(search?: string, authHeader: string | null = 'Bearer token') {
  const url = search ? `${BASE_URL}?${search}` : BASE_URL
  return new NextRequest(url, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function makePost(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-b/projects', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet(undefined, null))
    expect(res.status).toBe(401)
  })

  it('returns an empty list when the user has no projects', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    projectDelegate.findMany.mockResolvedValue([])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.projects).toEqual([])
  })

  it('returns 400 for an invalid status filter', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await GET(makeGet('status=deleted'))
    expect(res.status).toBe(400)
  })

  it('filters by status when provided', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    projectDelegate.findMany.mockResolvedValue([])
    await GET(makeGet('status=active'))
    expect(projectDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'active' }) }),
    )
  })

  it('returns the user projects with nullable fields normalised', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    projectDelegate.findMany.mockResolvedValue([
      {
        id: 'p-1',
        title: 'My Project',
        description: null,
        clientName: 'ACME',
        status: 'active',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        archivedAt: null,
      },
    ])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.projects[0]).toMatchObject({ id: 'p-1', title: 'My Project', description: null, status: 'active' })
  })
})

describe('POST /api/routes-b/projects', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost({ title: 'Test' }, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 when title is missing', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await POST(makePost({}))
    expect(res.status).toBe(400)
  })

  it('returns 400 when title exceeds 200 characters', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await POST(makePost({ title: 'x'.repeat(201) }))
    expect(res.status).toBe(400)
  })

  it('creates a project and returns 201', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    projectDelegate.create.mockResolvedValue({
      id: 'p-new',
      title: 'New Project',
      description: 'desc',
      clientName: null,
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const res = await POST(makePost({ title: 'New Project', description: 'desc' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.project).toMatchObject({ id: 'p-new', title: 'New Project', status: 'active' })
    expect(projectDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', title: 'New Project', status: 'active' }),
      }),
    )
  })

  it('creates a project with minimal fields (title only)', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    projectDelegate.create.mockResolvedValue({
      id: 'p-2',
      title: 'Minimal',
      description: null,
      clientName: null,
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const res = await POST(makePost({ title: 'Minimal' }))
    expect(res.status).toBe(201)
  })
})
