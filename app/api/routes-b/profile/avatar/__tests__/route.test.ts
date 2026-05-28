import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { update: userUpdate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/profile/avatar'

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(BASE_URL, {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer token',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/routes-b/profile/avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects avatar metadata over the maximum file size', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    const { PATCH } = await import('../route')

    const res = await PATCH(makeRequest({
      avatarUrl: 'https://cdn.example.com/avatar.png',
      fileSize: 2 * 1024 * 1024 + 1,
      mimeType: 'image/png',
    }))

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Avatar exceeds 2097152 bytes' })
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('rejects non-image avatar MIME types', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    const { PATCH } = await import('../route')

    const res = await PATCH(makeRequest({
      avatarUrl: 'https://cdn.example.com/avatar.txt',
      fileSize: 1024,
      mimeType: 'text/plain',
    }))

    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'Unsupported avatar MIME type' })
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('accepts allowed image MIME types within the file size limit', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userUpdate.mockResolvedValue({ avatarUrl: 'https://cdn.example.com/avatar.webp' })
    const { PATCH } = await import('../route')

    const res = await PATCH(makeRequest({
      avatarUrl: 'https://cdn.example.com/avatar.webp',
      fileSize: 2 * 1024 * 1024,
      mimeType: 'image/webp',
    }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ avatarUrl: 'https://cdn.example.com/avatar.webp' })
    expect(userUpdate).toHaveBeenCalledWith({
      where: { privyId: 'privy_1' },
      data: { avatarUrl: 'https://cdn.example.com/avatar.webp' },
      select: { avatarUrl: true },
    })
  })
})
