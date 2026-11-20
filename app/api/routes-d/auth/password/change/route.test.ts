import { NextRequest } from 'next/server'
import { POST } from './route'

jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn(), update: jest.fn() } } }))
jest.mock('@/lib/auth', () => ({ verifyAuthToken: jest.fn() }))
jest.mock('@/lib/logger', () => ({ logger: { info: jest.fn(), error: jest.fn() } }))
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn().mockResolvedValue('new-hash'),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import bcrypt from 'bcryptjs'

const mockVerify = verifyAuthToken as jest.Mock
const mockCompare = bcrypt.compare as jest.Mock
const mockUpdate = prisma.user.update as jest.Mock

function makeReq(body: unknown) {
  return new NextRequest('http://localhost/api/routes-d/auth/password/change', {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVerify.mockResolvedValue({ userId: 'privy-1' });
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'user-1', passwordHash: 'old-hash' })
  mockCompare.mockResolvedValue(true)
  mockUpdate.mockResolvedValue({})
})

test('POST 401 when unauthenticated', async () => {
  mockVerify.mockResolvedValue(null)
  const res = await POST(makeReq({ currentPassword: 'old', newPassword: 'newpass1' }))
  expect(res.status).toBe(401)
})

test('POST 400 missing currentPassword', async () => {
  const res = await POST(makeReq({ newPassword: 'newpass1' }))
  expect(res.status).toBe(400)
  expect((await res.json()).error).toMatch(/currentPassword/)
})

test('POST 400 missing newPassword', async () => {
  const res = await POST(makeReq({ currentPassword: 'old' }))
  expect(res.status).toBe(400)
})

test('POST 400 newPassword too short', async () => {
  const res = await POST(makeReq({ currentPassword: 'old', newPassword: 'short' }))
  expect(res.status).toBe(400)
  expect((await res.json()).error).toMatch(/8/)
})

test('POST 400 same password', async () => {
  const res = await POST(makeReq({ currentPassword: 'samepass1', newPassword: 'samepass1' }))
  expect(res.status).toBe(400)
  expect((await res.json()).error).toMatch(/differ/)
})

test('POST 422 no password hash on account', async () => {
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'user-1', passwordHash: null })
  const res = await POST(makeReq({ currentPassword: 'old', newPassword: 'newpass1' }))
  expect(res.status).toBe(422)
})

test('POST 403 wrong current password', async () => {
  mockCompare.mockResolvedValue(false)
  const res = await POST(makeReq({ currentPassword: 'wrongpass', newPassword: 'newpass1' }))
  expect(res.status).toBe(403)
})

test('POST 200 success changes password', async () => {
  const res = await POST(makeReq({ currentPassword: 'oldpassword', newPassword: 'newpassword1' }))
  expect(res.status).toBe(200)
  expect((await res.json()).message).toMatch(/changed/)
  expect(mockUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 'user-1' } }),
  )
})
