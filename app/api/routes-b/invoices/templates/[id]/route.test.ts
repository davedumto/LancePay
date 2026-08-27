import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoiceTemplate: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>
const mockUserFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockTemplateFindUnique = prisma.invoiceTemplate.findUnique as unknown as ReturnType<typeof vi.fn>

function makeGet(id: string, token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(`http://localhost/api/routes-b/invoices/templates/${id}`, { headers })
}

function callGet(id: string, token: string | null = 'Bearer valid-token') {
  return GET(makeGet(id, token), { params: Promise.resolve({ id }) })
}

const mockTemplate = {
  id: 'tmpl-1',
  userId: 'user-1',
  name: 'Standard Web Project',
  clientEmail: 'client@example.com',
  clientName: 'Acme Corp',
  description: 'Website redesign',
  amount: { toString: () => '1500' },
  currency: 'USD',
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-01'),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockResolvedValue({ userId: 'privy-1' })
  mockUserFindUnique.mockResolvedValue({ id: 'user-1' })
  mockTemplateFindUnique.mockResolvedValue(mockTemplate)
})

describe('GET /api/routes-b/invoices/templates/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await callGet('tmpl-1', null)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    mockVerify.mockResolvedValue(null)
    const res = await callGet('tmpl-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record is missing', async () => {
    mockUserFindUnique.mockResolvedValue(null)
    const res = await callGet('tmpl-1')
    expect(res.status).toBe(404)
  })

  it('returns 404 when the template does not exist', async () => {
    mockTemplateFindUnique.mockResolvedValue(null)
    const res = await callGet('missing')
    expect(res.status).toBe(404)
  })

  it('returns 403 when the template belongs to another user', async () => {
    mockTemplateFindUnique.mockResolvedValue({ ...mockTemplate, userId: 'someone-else' })
    const res = await callGet('tmpl-1')
    expect(res.status).toBe(403)
  })

  it('returns 200 with the template on the happy path', async () => {
    const res = await callGet('tmpl-1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.template.id).toBe('tmpl-1')
    expect(json.template.amount).toBe(1500)
  })

  it('returns 500 when an unexpected error occurs', async () => {
    mockTemplateFindUnique.mockRejectedValue(new Error('db unavailable'))
    const res = await callGet('tmpl-1')
    expect(res.status).toBe(500)
  })
})
