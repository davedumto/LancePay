import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { deviceFindFirst, deviceCreate, deviceUpdate } = vi.hoisted(() => ({
  deviceFindFirst: vi.fn(),
  deviceCreate: vi.fn(),
  deviceUpdate: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    device: {
      findFirst: deviceFindFirst,
      create: deviceCreate,
      update: deviceUpdate,
    },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)

function makePost(body: unknown, auth: string | null = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/devices/register', {
    method: 'POST',
    headers: {
      ...(auth ? { authorization: auth } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-d/devices/register', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when no auth header is provided', async () => {
    const res = await POST(makePost({ token: 'tok', platform: 'ios' }, null))
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost({ token: 'tok', platform: 'ios' }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue(null as never)
    const res = await POST(makePost({ token: 'tok', platform: 'ios' }))
    expect(res.status).toBe(404)
  })

  it('returns 400 when token is missing', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    const res = await POST(makePost({ platform: 'ios' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when platform is invalid', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    const res = await POST(makePost({ token: 'device-tok', platform: 'windows' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/platform/)
  })

  it('returns 400 for invalid JSON body', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)

    const req = new NextRequest('http://localhost/api/routes-d/devices/register', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: 'not-json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 201 when device is registered successfully (new device)', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    deviceFindFirst.mockResolvedValue(null)
    deviceCreate.mockResolvedValue({
      id: 'device-1',
      token: 'device-tok',
      platform: 'ios',
      deviceName: null,
      createdAt: new Date(),
    })

    const res = await POST(makePost({ token: 'device-tok', platform: 'ios' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.device.id).toBe('device-1')
  })

  it('returns 200 when device already exists (update)', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    deviceFindFirst.mockResolvedValue({ id: 'device-1', token: 'device-tok' })
    deviceUpdate.mockResolvedValue({
      id: 'device-1',
      token: 'device-tok',
      platform: 'android',
      deviceName: 'My Phone',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const res = await POST(makePost({ token: 'device-tok', platform: 'android', deviceName: 'My Phone' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.device.platform).toBe('android')
  })

  it('returns 500 on unexpected error', async () => {
    mockedVerify.mockRejectedValue(new Error('DB error') as never)
    const res = await POST(makePost({ token: 'tok', platform: 'ios' }))
    expect(res.status).toBe(500)
  })
})
