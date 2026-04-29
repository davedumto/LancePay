import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE, GET, PATCH } from '../[id]/route'
import { buildParams, buildRequest, makeTag, makeUser } from '../../_lib/test-helpers'

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
      update: vi.fn(),
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
const mockedTagUpdate = vi.mocked(prisma.tag.update)
const mockedTagDelete = vi.mocked(prisma.tag.delete)
const mockedInvoiceTagDeleteMany = vi.mocked(prisma.invoiceTag.deleteMany)

describe('GET /api/routes-b/tags/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser() as never)
  })

  it('returns tag when it exists', async () => {
    mockedTagFindUnique.mockResolvedValue(makeTag({ id: 'tag-1', invoiceCount: 2 }) as never)
    const response = await GET(
      buildRequest('GET', 'http://localhost/api/routes-b/tags/tag-1', { token: 'token' }),
      buildParams('tag-1'),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      id: 'tag-1',
      name: 'Alpha',
      color: '#6366f1',
      invoiceCount: 2,
    })
  })

  it('returns 404 when tag does not exist', async () => {
    mockedTagFindUnique.mockResolvedValue(null as never)
    const response = await GET(
      buildRequest('GET', 'http://localhost/api/routes-b/tags/missing', { token: 'token' }),
      buildParams('missing'),
    )
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: 'Tag not found' })
  })
})

describe('PATCH /api/routes-b/tags/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser() as never)
  })

  it('applies partial update', async () => {
    mockedTagFindUnique
      .mockResolvedValueOnce(makeTag({ id: 'tag-1', name: 'Alpha' }) as never)
      .mockResolvedValueOnce(null as never)
    mockedTagUpdate.mockResolvedValue(makeTag({ id: 'tag-1', name: 'Renamed' }) as never)

    const response = await PATCH(
      buildRequest('PATCH', 'http://localhost/api/routes-b/tags/tag-1', {
        token: 'token',
        body: { name: 'Renamed' },
      }),
      buildParams('tag-1'),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ id: 'tag-1', name: 'Renamed' })
    expect(mockedTagUpdate).toHaveBeenCalledOnce()
  })

  it('returns existing tag without update for no-op payload', async () => {
    mockedTagFindUnique.mockResolvedValue(makeTag({ id: 'tag-1', name: 'Alpha', color: '#111111' }) as never)

    const response = await PATCH(
      buildRequest('PATCH', 'http://localhost/api/routes-b/tags/tag-1', {
        token: 'token',
        body: { name: 'Alpha', color: '#111111' },
      }),
      buildParams('tag-1'),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ id: 'tag-1', name: 'Alpha', color: '#111111' })
    expect(mockedTagUpdate).not.toHaveBeenCalled()
  })

  it('returns conflict when new name already exists', async () => {
    mockedTagFindUnique
      .mockResolvedValueOnce(makeTag({ id: 'tag-1', name: 'Alpha' }) as never)
      .mockResolvedValueOnce(makeTag({ id: 'tag-2', name: 'Taken' }) as never)

    const response = await PATCH(
      buildRequest('PATCH', 'http://localhost/api/routes-b/tags/tag-1', {
        token: 'token',
        body: { name: 'Taken' },
      }),
      buildParams('tag-1'),
    )
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toEqual({ error: 'Tag with this name already exists' })
    expect(mockedTagUpdate).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/routes-b/tags/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser() as never)
  })

  it('deletes tag successfully', async () => {
    mockedTagFindUnique.mockResolvedValue(makeTag({ id: 'tag-1' }) as never)
    mockedInvoiceTagDeleteMany.mockResolvedValue({ count: 0 } as never)
    mockedTagDelete.mockResolvedValue({ id: 'tag-1' } as never)

    const response = await DELETE(
      buildRequest('DELETE', 'http://localhost/api/routes-b/tags/tag-1', { token: 'token' }),
      buildParams('tag-1'),
    )

    expect(response.status).toBe(204)
    expect(mockedTagDelete).toHaveBeenCalledWith({ where: { id: 'tag-1' } })
  })

  it('returns 404 when tag does not exist', async () => {
    mockedTagFindUnique.mockResolvedValue(null as never)

    const response = await DELETE(
      buildRequest('DELETE', 'http://localhost/api/routes-b/tags/missing', { token: 'token' }),
      buildParams('missing'),
    )
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: 'Tag not found' })
  })

  it('removes invoice tag links before deleting tag', async () => {
    mockedTagFindUnique.mockResolvedValue(makeTag({ id: 'tag-1' }) as never)
    mockedInvoiceTagDeleteMany.mockResolvedValue({ count: 3 } as never)
    mockedTagDelete.mockResolvedValue({ id: 'tag-1' } as never)

    const response = await DELETE(
      buildRequest('DELETE', 'http://localhost/api/routes-b/tags/tag-1', { token: 'token' }),
      buildParams('tag-1'),
    )

    expect(response.status).toBe(204)
    expect(mockedInvoiceTagDeleteMany).toHaveBeenCalledWith({ where: { tagId: 'tag-1' } })
    expect(mockedTagDelete).toHaveBeenCalledWith({ where: { id: 'tag-1' } })
  })
})

