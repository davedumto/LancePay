import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, EMAIL_TEMPLATE_VARIABLES, EMAIL_TEMPLATE_CATEGORIES } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'

function makeRequest(url = 'http://localhost:3000/api/routes-b/email-templates/variables', token = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(url, { headers })
}

describe('GET /api/routes-b/email-templates/variables', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
  })

  it('returns all available template variables for authenticated user', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.variables).toHaveLength(EMAIL_TEMPLATE_VARIABLES.length)
    expect(data.count).toBe(EMAIL_TEMPLATE_VARIABLES.length)
    expect(data.categories).toEqual(EMAIL_TEMPLATE_CATEGORIES)
    expect(data.variables[0]).toHaveProperty('key')
    expect(data.variables[0]).toHaveProperty('name')
    expect(data.variables[0]).toHaveProperty('description')
    expect(data.variables[0]).toHaveProperty('category')
    expect(data.variables[0]).toHaveProperty('example')
  })

  it('filters variables by category when valid category query param provided', async () => {
    const res = await GET(makeRequest('http://localhost:3000/api/routes-b/email-templates/variables?category=invoice'))
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.variables.length).toBeGreaterThan(0)
    expect(data.variables.every((v: { category: string }) => v.category === 'invoice')).toBe(true)
    expect(data.count).toBe(data.variables.length)
  })

  it('returns 400 when an invalid category is supplied', async () => {
    const res = await GET(makeRequest('http://localhost:3000/api/routes-b/email-templates/variables?category=unknown_cat'))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Invalid category')
  })

  it('returns 401 when no authorization header is provided', async () => {
    const req = new NextRequest('http://localhost:3000/api/routes-b/email-templates/variables')
    const res = await GET(req)
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when auth token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when user is not found in database', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected server error', async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('DB failure'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Failed to list email template variables')
  })
})
