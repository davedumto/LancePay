import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const projectFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    project: { findUnique: projectFindUnique },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function getRequest(id: string) {
  return new NextRequest(`http://localhost/api/routes-b/projects/${id}`, {
    headers: { authorization: 'Bearer tok' },
  })
}

describe('GET /api/routes-b/projects/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth token', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/projects/[id]/route')
    const res = await GET(
      new NextRequest('http://localhost/api/routes-b/projects/p1'),
      { params: Promise.resolve({ id: 'p1' }) },
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when project does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    projectFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/projects/[id]/route')
    const res = await GET(getRequest('missing'), { params: Promise.resolve({ id: 'missing' }) })
    expect(res.status).toBe(404)
  })

  it('returns 403 when project belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    projectFindUnique.mockResolvedValue({ id: 'p1', userId: 'user_2', status: 'active' })
    const { GET } = await import('@/app/api/routes-b/projects/[id]/route')
    const res = await GET(getRequest('p1'), { params: Promise.resolve({ id: 'p1' }) })
    expect(res.status).toBe(403)
  })

  it('returns 200 with project data for the owner', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    projectFindUnique.mockResolvedValue({
      id: 'p1',
      userId: 'user_1',
      title: 'My Project',
      description: null,
      clientName: 'ACME',
      status: 'active',
      archivedAt: null,
      createdAt: new Date('2026-06-23'),
      updatedAt: new Date('2026-06-23'),
    })
    const { GET } = await import('@/app/api/routes-b/projects/[id]/route')
    const res = await GET(getRequest('p1'), { params: Promise.resolve({ id: 'p1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.project.id).toBe('p1')
    expect(body.project.title).toBe('My Project')
  })
})
