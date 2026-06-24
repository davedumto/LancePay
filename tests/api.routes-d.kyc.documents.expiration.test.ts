import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const kycDocumentFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    kycDocument: { findUnique: kycDocumentFindUnique },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/kyc/documents'

function makeRequest(method: string, id: string, token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(`${BASE_URL}/${id}/expiration`, {
    method,
    headers,
  })
}

describe('GET /api/routes-d/kyc/documents/[id]/expiration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 if no authorization header is provided', async () => {
    const { GET } = await import('@/app/api/routes-d/kyc/documents/[id]/expiration/route')
    const res = await GET(makeRequest('GET', 'doc_123', null), { params: Promise.resolve({ id: 'doc_123' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 if document does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    kycDocumentFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/kyc/documents/[id]/expiration/route')
    const res = await GET(makeRequest('GET', 'doc_123'), { params: Promise.resolve({ id: 'doc_123' }) })
    expect(res.status).toBe(404)
  })

  it('returns 403 if document belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    kycDocumentFindUnique.mockResolvedValue({ id: 'doc_123', userId: 'user-2' })

    const { GET } = await import('@/app/api/routes-d/kyc/documents/[id]/expiration/route')
    const res = await GET(makeRequest('GET', 'doc_123'), { params: Promise.resolve({ id: 'doc_123' }) })
    expect(res.status).toBe(403)
  })

  it('returns 200 and calculates expiration for utility bill (90 days)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    
    const createdAt = new Date() // uploaded today
    kycDocumentFindUnique.mockResolvedValue({
      id: 'doc_123',
      userId: 'user-1',
      documentType: 'utility_bill',
      createdAt,
    })

    const { GET } = await import('@/app/api/routes-d/kyc/documents/[id]/expiration/route')
    const res = await GET(makeRequest('GET', 'doc_123'), { params: Promise.resolve({ id: 'doc_123' }) })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.documentId).toBe('doc_123')
    expect(json.status).toBe('valid')
    expect(json.isExpired).toBe(false)
    expect(json.daysRemaining).toBe(90)
    expect(json.expiresAt).toBeDefined()
  })

  it('returns status expired for old utility bill', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    
    // uploaded 100 days ago
    const createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    kycDocumentFindUnique.mockResolvedValue({
      id: 'doc_123',
      userId: 'user-1',
      documentType: 'utility_bill',
      createdAt,
    })

    const { GET } = await import('@/app/api/routes-d/kyc/documents/[id]/expiration/route')
    const res = await GET(makeRequest('GET', 'doc_123'), { params: Promise.resolve({ id: 'doc_123' }) })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe('expired')
    expect(json.isExpired).toBe(true)
  })
})
