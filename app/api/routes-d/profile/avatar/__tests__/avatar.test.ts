import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({ prisma: { user: { update: vi.fn() } } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { PATCH } from '../route'

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

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
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
