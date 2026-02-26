/**
 * Integration-style unit tests for the invoice template CRUD endpoints.
 *
 * We mock Prisma and the auth helper so these tests run without a real DB,
 * making them fast and reliable in CI.
 */
import { NextRequest } from 'next/server'
import { GET, POST, PUT } from './route'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUser = { id: 'user-123', privyId: 'privy-abc' }

jest.mock('@/lib/auth', () => ({
  verifyAuthToken: jest.fn().mockResolvedValue({ userId: 'privy-abc' }),
}))

const mockFindUnique = jest.fn()
const mockFindMany = jest.fn()
const mockCreate = jest.fn()
const mockUpdate = jest.fn()
const mockUpdateMany = jest.fn()
const mockTransaction = jest.fn()

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: (...args: any[]) => mockFindUnique(...args) },
    invoiceTemplate: {
      findMany: (...args: any[]) => mockFindMany(...args),
      findUnique: (...args: any[]) => mockFindUnique(...args),
      create: (...args: any[]) => mockCreate(...args),
      update: (...args: any[]) => mockUpdate(...args),
      updateMany: (...args: any[]) => mockUpdateMany(...args),
    },
    $transaction: (fn: any) => mockTransaction(fn),
  },
}))

jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn() } }))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(method: string, body?: object, searchParams?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/routes-d/branding/templates')
  if (searchParams) {
    Object.entries(searchParams).forEach(([k, v]) => url.searchParams.set(k, v))
  }
  return new NextRequest(url.toString(), {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/routes-d/branding/templates', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // user lookup always succeeds
    mockFindUnique.mockResolvedValue(mockUser)
  })

  it('returns all templates for the authenticated user, default first', async () => {
    const templates = [
      { id: 't1', userId: 'user-123', name: 'Default', isDefault: true, layout: 'modern' },
      { id: 't2', userId: 'user-123', name: 'Classic', isDefault: false, layout: 'classic' },
    ]
    mockFindMany.mockResolvedValue(templates)

    const res = await GET(makeRequest('GET'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.templates).toHaveLength(2)
    // The default template should come back first (DB orderBy isDefault desc)
    expect(json.templates[0].isDefault).toBe(true)
  })

  it('returns 401 when auth token is invalid', async () => {
    const { verifyAuthToken } = require('@/lib/auth')
    verifyAuthToken.mockResolvedValueOnce(null) // simulate bad token

    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/routes-d/branding/templates', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindUnique.mockResolvedValue(mockUser)
  })

  it('creates a template and clears any existing default when isDefault=true', async () => {
    const created = {
      id: 'new-t1',
      userId: 'user-123',
      name: 'My Brand',
      isDefault: true,
      primaryColor: '#FF0000',
      accentColor: '#6366f1',
      showLogo: true,
      showFooter: true,
      footerText: 'Acme Inc.',
      layout: 'modern',
    }

    // $transaction executes the callback; we simulate it synchronously here.
    mockTransaction.mockImplementation(async (fn: any) => {
      const txClient = {
        invoiceTemplate: {
          updateMany: mockUpdateMany,
          create: mockCreate,
        },
      }
      return fn(txClient)
    })
    mockUpdateMany.mockResolvedValue({ count: 1 }) // one existing default cleared
    mockCreate.mockResolvedValue(created)

    const res = await POST(
      makeRequest('POST', {
        name: 'My Brand',
        isDefault: true,
        primaryColor: '#FF0000',
        footerText: 'Acme Inc.',
        layout: 'modern',
      })
    )
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.success).toBe(true)
    expect(json.template.isDefault).toBe(true)
    // Ensure we cleared the old default inside the transaction
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-123', isDefault: true }),
        data: { isDefault: false },
      })
    )
  })

  it('returns 400 for an invalid hex color', async () => {
    const res = await POST(
      makeRequest('POST', {
        name: 'Bad Colors',
        primaryColor: 'not-a-color', // invalid
        layout: 'modern',
      })
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('Validation failed')
    expect(json.details.primaryColor).toBeDefined()
  })
})

describe('PUT /api/routes-d/branding/templates', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects updates to templates owned by another user (returns 404)', async () => {
    // User lookup returns our user
    mockFindUnique
      .mockResolvedValueOnce(mockUser) // user lookup
      .mockResolvedValueOnce({ userId: 'other-user-999' }) // template belongs to someone else

    const res = await PUT(makeRequest('PUT', { id: 'stolen-template', name: 'Hijack' }))
    const json = await res.json()

    // Must be 404, not 403, to avoid disclosing that the resource exists
    expect(res.status).toBe(404)
    expect(json.error).toBe('Template not found')
  })

  it('promotes no extra default when isDefault is absent in the update payload', async () => {
    mockFindUnique
      .mockResolvedValueOnce(mockUser)
      .mockResolvedValueOnce({ userId: 'user-123' }) // template ownership check

    const updated = { id: 't1', name: 'Renamed', isDefault: false }
    mockTransaction.mockImplementation(async (fn: any) => {
      const txClient = {
        invoiceTemplate: {
          updateMany: mockUpdateMany,
          update: mockUpdate,
        },
      }
      return fn(txClient)
    })
    mockUpdate.mockResolvedValue(updated)

    const res = await PUT(
      makeRequest('PUT', { id: 't1', name: 'Renamed' }, { id: 't1' })
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    // updateMany (clear default) must NOT have been called — isDefault wasn't set
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })
})
