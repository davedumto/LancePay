import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({ prisma: { user: { update: vi.fn() } } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { PATCH, POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUpdate = vi.mocked(prisma.user.update)

function req(body: unknown, auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/profile/avatar', {
    method: 'PATCH',
    headers: {
      ...(auth ? { authorization: auth } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function createFormData(file: File | null, auth = 'Bearer token'): NextRequest {
  const formData = new FormData()
  if (file) {
    formData.append('avatar', file)
  }
  return new NextRequest('http://localhost/api/routes-d/profile/avatar', {
    method: 'POST',
    headers: {
      ...(auth ? { authorization: auth } : {}),
    },
    body: formData,
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
})

describe('POST /api/routes-d/profile/avatar', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' })
    expect((await POST(createFormData(file, ''))).status).toBe(401)
  })

  it('returns 400 when avatar file is missing', async () => {
    expect((await POST(createFormData(null))).status).toBe(400)
  })

  it('returns 413 when file size exceeds 5MB', async () => {
    const largeBuffer = new Uint8Array(6 * 1024 * 1024) // 6MB
    const file = new File([largeBuffer], 'large.jpg', { type: 'image/jpeg' })
    expect((await POST(createFormData(file))).status).toBe(413)
  })

  it('returns 415 for invalid MIME type', async () => {
    const file = new File(['test'], 'test.pdf', { type: 'application/pdf' })
    expect((await POST(createFormData(file))).status).toBe(415)
  })

  it('returns 415 for invalid file content', async () => {
    const file = new File(['not an image'], 'fake.jpg', { type: 'image/jpeg' })
    expect((await POST(createFormData(file))).status).toBe(415)
  })

  it('uploads and returns avatar URL for valid JPEG', async () => {
    const jpegBuffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
    const file = new File([jpegBuffer], 'test.jpg', { type: 'image/jpeg' })
    mockedUpdate.mockResolvedValue({ avatarUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' } as never)
    const res = await POST(createFormData(file))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.avatarUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { privyId: 'privy-1' },
      }),
    )
  })

  it('uploads and returns avatar URL for valid PNG', async () => {
    const pngBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const file = new File([pngBuffer], 'test.png', { type: 'image/png' })
    mockedUpdate.mockResolvedValue({ avatarUrl: 'data:image/png;base64,iVBORw0KGgo=' } as never)
    const res = await POST(createFormData(file))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.avatarUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('uploads and returns avatar URL for valid WebP', async () => {
    const webpBuffer = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
    const file = new File([webpBuffer], 'test.webp', { type: 'image/webp' })
    mockedUpdate.mockResolvedValue({ avatarUrl: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4=' } as never)
    const res = await POST(createFormData(file))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.avatarUrl).toMatch(/^data:image\/webp;base64,/)
  })

  it('uploads and returns avatar URL for valid GIF', async () => {
    const gifBuffer = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    const file = new File([gifBuffer], 'test.gif', { type: 'image/gif' })
    mockedUpdate.mockResolvedValue({ avatarUrl: 'data:image/gif;base64,R0lG' } as never)
    const res = await POST(createFormData(file))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.avatarUrl).toMatch(/^data:image\/gif;base64,/)
  })
})

describe('PATCH /api/routes-d/profile/avatar', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await PATCH(req({ avatarUrl: 'https://x/a.png' }, ''))).status).toBe(401)
  })

  it('returns 400 when avatarUrl is missing', async () => {
    expect((await PATCH(req({}))).status).toBe(400)
  })

  it('returns 400 for a non-string avatarUrl', async () => {
    expect((await PATCH(req({ avatarUrl: 123 }))).status).toBe(400)
  })

  it('returns 400 for a non-HTTPS URL', async () => {
    expect((await PATCH(req({ avatarUrl: 'http://x/a.png' }))).status).toBe(400)
  })

  it('returns 400 when avatarUrl exceeds 512 chars', async () => {
    const long = `https://x/${'a'.repeat(520)}.png`
    expect((await PATCH(req({ avatarUrl: long }))).status).toBe(400)
  })

  it('updates the avatar for a valid HTTPS URL', async () => {
    mockedUpdate.mockResolvedValue({ avatarUrl: 'https://cdn/a.png' } as never)
    const res = await PATCH(req({ avatarUrl: 'https://cdn/a.png' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ avatarUrl: 'https://cdn/a.png' })
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { privyId: 'privy-1' },
        data: { avatarUrl: 'https://cdn/a.png' },
      }),
    )
  })

  it('allows clearing the avatar with null', async () => {
    mockedUpdate.mockResolvedValue({ avatarUrl: null } as never)
    const res = await PATCH(req({ avatarUrl: null }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ avatarUrl: null })
  })
})
