import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, DELETE } from '../route'
import { buildRequest, makeTag, makeUser } from '../../../_lib/test-helpers'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    tag: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    invoiceTag: {
      deleteMany: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerifyAuthToken = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedTagFindUnique = vi.mocked(prisma.tag.findUnique)
const mockedInvoiceTagDeleteMany = vi.mocked(prisma.invoiceTag.deleteMany)
const mockedTagDelete = vi.mocked(prisma.tag.delete)

describe('GET /api/routes-b/tags/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser({ id: 'user-1' }) as never)
  })

  it('returns 404 when tag is not found', async () => {
    mockedTagFindUnique.mockResolvedValue(null as never)
    const request = buildRequest('GET', 'http://localhost/api/routes-b/tags/tag-1', { token: 'token' })
    const response = await GET(request, { params: Promise.resolve({ id: 'tag-1' }) } as any)
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: 'Tag not found' })
  })

  it('returns tag details when found', async () => {
    const tag = makeTag({ id: 'tag-1', userId: 'user-1', name: 'Alpha', invoiceCount: 1 })
    mockedTagFindUnique.mockResolvedValue({
      ...tag,
      _count: { invoiceTags: 1 }
    } as never)
    
    const request = buildRequest('GET', 'http://localhost/api/routes-b/tags/tag-1', { token: 'token' })
    const response = await GET(request, { params: Promise.resolve({ id: 'tag-1' }) } as any)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.id).toBe('tag-1')
    expect(body.name).toBe('Alpha')
    expect(body.invoiceCount).toBe(1)
  })
})

describe('DELETE /api/routes-b/tags/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser({ id: 'user-1' }) as never)
  })

  it('returns 404 when tag to delete is not found', async () => {
    mockedTagFindUnique.mockResolvedValue(null as never)
    const request = buildRequest('DELETE', 'http://localhost/api/routes-b/tags/tag-1', { token: 'token' })
    const response = await DELETE(request, { params: Promise.resolve({ id: 'tag-1' }) } as any)
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: 'Tag not found' })
    expect(mockedTagDelete).not.toHaveBeenCalled()
  })

  it('deletes tag and its associations when successful', async () => {
    const tag = makeTag({ id: 'tag-1', userId: 'user-1' })
    mockedTagFindUnique.mockResolvedValue(tag as never)
    
    const request = buildRequest('DELETE', 'http://localhost/api/routes-b/tags/tag-1', { token: 'token' })
    const response = await DELETE(request, { params: Promise.resolve({ id: 'tag-1' }) } as any)

    expect(response.status).toBe(204)
    expect(mockedInvoiceTagDeleteMany).toHaveBeenCalledWith({ where: { tagId: 'tag-1' } })
    expect(mockedTagDelete).toHaveBeenCalledWith({ where: { id: 'tag-1' } })
  })
})
