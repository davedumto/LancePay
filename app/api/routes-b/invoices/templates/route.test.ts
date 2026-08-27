import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoiceTemplate: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>
const mockUserFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockFindMany = prisma.invoiceTemplate.findMany as unknown as ReturnType<typeof vi.fn>
const mockCreate = prisma.invoiceTemplate.create as unknown as ReturnType<typeof vi.fn>
const mockTemplateFindUnique = prisma.invoiceTemplate.findUnique as unknown as ReturnType<typeof vi.fn>

const BASE_URL = 'http://localhost/api/routes-b/invoices/templates'

function makeGet(token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(BASE_URL, { headers })
}

function makePost(body: unknown, token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = token
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const mockTemplate = {
  id: 'tmpl-1',
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
  mockFindMany.mockResolvedValue([mockTemplate])
  mockTemplateFindUnique.mockResolvedValue(null)
  mockCreate.mockResolvedValue({
    id: 'tmpl-new',
    name: 'New Template',
    clientEmail: null,
    clientName: null,
    description: 'Consulting',
    amount: { toString: () => '500' },
    currency: 'USD',
    createdAt: new Date('2026-08-25'),
    updatedAt: new Date('2026-08-25'),
  })
})

describe('GET /api/routes-b/invoices/templates', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await GET(makeGet(null))
    expect(res.status).toBe(401)
  })

  it('returns 200 with the templates on the happy path', async () => {
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.templates).toHaveLength(1)
    expect(json.templates[0].amount).toBe(1500)
  })

  it('scopes the query to the authenticated user', async () => {
    await GET(makeGet())
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    )
  })

  it('returns 500 when an unexpected error occurs', async () => {
    mockFindMany.mockRejectedValue(new Error('db unavailable'))
    const res = await GET(makeGet())
    expect(res.status).toBe(500)
  })
})

describe('POST /api/routes-b/invoices/templates', () => {
  const validBody = { name: 'New Template', description: 'Consulting', amount: 500 }

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(makePost(validBody, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 when the JSON body is invalid', async () => {
    const res = await POST(makePost('not-json'))
    expect(res.status).toBe(400)
  })

  it('returns 400 when name is missing', async () => {
    const res = await POST(makePost({ ...validBody, name: undefined }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when description is missing', async () => {
    const res = await POST(makePost({ ...validBody, description: undefined }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when amount is not a positive number', async () => {
    const res = await POST(makePost({ ...validBody, amount: -10 }))
    expect(res.status).toBe(400)
  })

  it('returns 409 when a template with the same name already exists', async () => {
    mockTemplateFindUnique.mockResolvedValue({ id: 'existing' })
    const res = await POST(makePost(validBody))
    expect(res.status).toBe(409)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates a template and returns 201 on the happy path', async () => {
    const res = await POST(makePost(validBody))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.template.name).toBe('New Template')
    expect(json.template.amount).toBe(500)
  })

  it('returns 500 when an unexpected error occurs', async () => {
    mockCreate.mockRejectedValue(new Error('db unavailable'))
    const res = await POST(makePost(validBody))
    expect(res.status).toBe(500)
  })
})
