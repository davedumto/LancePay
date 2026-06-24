import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const kycDocumentFindMany = vi.fn()
const kycDocumentCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    kycDocument: { findMany: kycDocumentFindMany, create: kycDocumentCreate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/kyc/documents'

function makeRequest(method: string, body?: unknown, opts?: { auth?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = opts?.auth ?? 'Bearer token'
  if (auth) headers.authorization = auth
  return new NextRequest(BASE_URL, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('GET /api/routes-d/kyc/documents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth header is supplied', async () => {
    const { GET } = await import('@/app/api/routes-d/kyc/documents/route')
    const res = await GET(makeRequest('GET', undefined, { auth: '' }))
    expect(res.status).toBe(401)
  })

  it('returns 401 for an invalid token', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/kyc/documents/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
  })

  it('returns the current user\'s KYC documents only', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    kycDocumentFindMany.mockResolvedValue([
      { id: 'doc_1', documentType: 'passport', status: 'uploaded', fileName: 'p.png', fileUrl: 'https://x/p.png', fileSize: 100, mimeType: 'image/png', createdAt: new Date('2025-01-01') },
    ])
    const { GET } = await import('@/app/api/routes-d/kyc/documents/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    expect(kycDocumentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_1' } }),
    )
    const json = await res.json()
    expect(json.documents).toHaveLength(1)
  })
})

describe('POST /api/routes-d/kyc/documents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/kyc/documents/route')
    const res = await POST(makeRequest('POST', {}))
    expect(res.status).toBe(401)
  })

  it('rejects an unsupported documentType', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/kyc/documents/route')
    const res = await POST(makeRequest('POST', { documentType: 'something_weird', fileUrl: 'https://x/y' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('documentType') }))
  })

  it('rejects a non-https fileUrl', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/kyc/documents/route')
    const res = await POST(makeRequest('POST', { documentType: 'passport', fileUrl: 'http://insecure/y' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('https') }))
  })

  it('rejects a fileSize that exceeds the cap', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/kyc/documents/route')
    const res = await POST(
      makeRequest('POST', {
        documentType: 'passport',
        fileUrl: 'https://x/y',
        fileSize: 100 * 1024 * 1024,
      }),
    )
    expect(res.status).toBe(400)
  })

  it('creates the document with 201 on a valid body', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const created = { id: 'doc_1', documentType: 'passport', status: 'uploaded' }
    kycDocumentCreate.mockResolvedValue(created)
    const { POST } = await import('@/app/api/routes-d/kyc/documents/route')
    const res = await POST(
      makeRequest('POST', { documentType: 'passport', fileUrl: 'https://x/p.png', fileSize: 5_000 }),
    )
    expect(res.status).toBe(201)
    expect(kycDocumentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user_1', documentType: 'passport' }),
      }),
    )
    const json = await res.json()
    expect(json.document).toEqual(created)
  })
})
