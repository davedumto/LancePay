import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const projectFindUnique = vi.fn()
const projectUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    project: { findUnique: projectFindUnique, update: projectUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function postRequest(id: string) {
  return new NextRequest(`http://localhost/api/routes-b/projects/${id}/archive`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok' },
  })
}

describe('POST /api/routes-b/projects/[id]/archive', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/projects/[id]/archive/route')
    const res = await POST(
      new NextRequest('http://localhost/api/routes-b/projects/p1/archive', { method: 'POST' }),
      { params: Promise.resolve({ id: 'p1' }) },
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when project not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    projectFindUnique.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/projects/[id]/archive/route')
    const res = await POST(postRequest('gone'), { params: Promise.resolve({ id: 'gone' }) })
    expect(res.status).toBe(404)
  })

  it('returns 403 when project belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    projectFindUnique.mockResolvedValue({ id: 'p1', userId: 'user_2', status: 'active' })
    const { POST } = await import('@/app/api/routes-b/projects/[id]/archive/route')
    const res = await POST(postRequest('p1'), { params: Promise.resolve({ id: 'p1' }) })
    expect(res.status).toBe(403)
  })

  it('is idempotent: returns 200 when project is already archived', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    projectFindUnique.mockResolvedValue({
      id: 'p1',
      userId: 'user_1',
      status: 'archived',
      archivedAt: new Date('2026-06-20'),
    })
    const { POST } = await import('@/app/api/routes-b/projects/[id]/archive/route')
    const res = await POST(postRequest('p1'), { params: Promise.resolve({ id: 'p1' }) })
    expect(res.status).toBe(200)
    expect(projectUpdate).not.toHaveBeenCalled()
  })

  it('archives an active project and returns updated record', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    projectFindUnique.mockResolvedValue({ id: 'p1', userId: 'user_1', status: 'active' })
    projectUpdate.mockResolvedValue({
      id: 'p1',
      title: 'Alpha',
      status: 'archived',
      archivedAt: new Date('2026-06-23'),
      updatedAt: new Date('2026-06-23'),
    })
    const { POST } = await import('@/app/api/routes-b/projects/[id]/archive/route')
    const res = await POST(postRequest('p1'), { params: Promise.resolve({ id: 'p1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.project.status).toBe('archived')
    expect(body.project.archivedAt).toBeTruthy()
    expect(projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'archived' }),
      }),
    )
  })
})
