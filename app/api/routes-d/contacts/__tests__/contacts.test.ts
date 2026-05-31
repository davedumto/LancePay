import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    contact: { findMany: vi.fn(), create: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const contactDelegate = prisma.contact as unknown as {
  findMany: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}

const BASE_URL = 'http://localhost/api/routes-d/contacts'

function makeGet(search?: string, authHeader: string | null = 'Bearer token') {
  const url = search ? `${BASE_URL}?search=${encodeURIComponent(search)}` : BASE_URL
  return new NextRequest(url, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function makePost(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-d/contacts', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 401 when the auth token is missing', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet(undefined, null))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(contactDelegate.findMany).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet())
    expect(res.status).toBe(401)
    expect(contactDelegate.findMany).not.toHaveBeenCalled()
  })

  it('lists the authenticated user contacts with nullable fields normalised', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    contactDelegate.findMany.mockResolvedValue([
      {
        id: 'c-1',
        name: 'Ada',
        email: 'ada@example.com',
        phone: '+1-555-1234',
        company: 'ACME',
        notes: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ])

    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.contacts).toHaveLength(1)
    expect(body.contacts[0]).toMatchObject({
      id: 'c-1',
      name: 'Ada',
      email: 'ada@example.com',
      phone: '+1-555-1234',
      company: 'ACME',
      notes: null,
    })
    expect(contactDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user_1' }) }),
    )
  })

  it('applies a case-insensitive search filter on name, email, and phone', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    contactDelegate.findMany.mockResolvedValue([])

    await GET(makeGet('ada'))
    expect(contactDelegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user_1',
          OR: [
            { name: { contains: 'ada', mode: 'insensitive' } },
            { email: { contains: 'ada', mode: 'insensitive' } },
            { phone: { contains: 'ada', mode: 'insensitive' } },
          ],
        },
      }),
    )
  })
})

describe('POST /api/routes-d/contacts', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost({ name: 'Ada', email: 'ada@example.com' }, null))
    expect(res.status).toBe(401)
    expect(contactDelegate.create).not.toHaveBeenCalled()
  })

  it('returns 400 with validation details when the name is missing', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    const res = await POST(makePost({ email: 'ada@example.com' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Validation failed')
    expect(body.details).toBeDefined()
    expect(contactDelegate.create).not.toHaveBeenCalled()
  })

  it('returns 400 with validation details when the email is invalid', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    const res = await POST(makePost({ name: 'Ada', email: 'not-an-email' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Validation failed')
    expect(body.details).toBeDefined()
    expect(contactDelegate.create).not.toHaveBeenCalled()
  })

  it('returns 400 with validation details when the phone is invalid', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    const res = await POST(makePost({ name: 'Ada', email: 'ada@example.com', phone: '123' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Validation failed')
    expect(body.details).toBeDefined()
    expect(contactDelegate.create).not.toHaveBeenCalled()
  })

  it('returns 400 with validation details when notes exceed the maximum length', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    const res = await POST(
      makePost({ name: 'Ada', email: 'ada@example.com', notes: 'x'.repeat(501) }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Validation failed')
    expect(body.details).toBeDefined()
    expect(contactDelegate.create).not.toHaveBeenCalled()
  })

  it('creates a contact and returns 201 with normalised fields including phone', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    contactDelegate.create.mockResolvedValue({
      id: 'c-1',
      name: 'Ada',
      email: 'ada@example.com',
      phone: '+1-555-1234',
      company: null,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })

    const res = await POST(makePost({ name: 'Ada', email: 'Ada@Example.com', phone: '+1-555-1234' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ 
      id: 'c-1', 
      email: 'ada@example.com', 
      phone: '+1-555-1234',
      company: null, 
      notes: null 
    })
    expect(contactDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ 
          userId: 'user_1', 
          name: 'Ada', 
          email: 'ada@example.com',
          phone: '+1-555-1234',
        }),
      }),
    )
  })

  it('creates a contact without phone field', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    contactDelegate.create.mockResolvedValue({
      id: 'c-1',
      name: 'Ada',
      email: 'ada@example.com',
      phone: null,
      company: null,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })

    const res = await POST(makePost({ name: 'Ada', email: 'Ada@Example.com' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.phone).toBeNull()
  })

  it('returns 409 when a contact with the same email already exists', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    contactDelegate.create.mockRejectedValue({ code: 'P2002' })

    const res = await POST(makePost({ name: 'Ada', email: 'ada@example.com' }))
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: 'A contact with this email already exists',
    })
  })
})
