import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    kycDocument: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    kycApplication: {
      findUnique: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))

import { GET, POST } from './route'

function makePostRequest(body: unknown, token: string | null = 'valid-token'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/kyc-documents', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function makeGetRequest(params = '', token: string | null = 'valid-token'): NextRequest {
  const url = `http://localhost/api/kyc-documents${params ? `?${params}` : ''}`
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(url, { method: 'GET', headers })
}

describe('POST /api/kyc-documents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'user-1',
      email: 'user@lancepay.io',
      role: 'user',
    })
    mockPrisma.kycApplication.findUnique.mockResolvedValue(null)
    mockPrisma.kycDocument.findFirst.mockResolvedValue(null)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(
      makePostRequest(
        {
          documentType: 'passport',
          fileUrl: 'https://cdn.lancepay.io/kyc/passport.pdf',
          fileName: 'passport.pdf',
          fileSize: 204800,
          mimeType: 'application/pdf',
        },
        null,
      ),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 for unsupported documentType, mimeType, or oversized fileSize', async () => {
    const badType = await POST(
      makePostRequest({
        documentType: 'library_card',
        fileUrl: 'https://cdn.lancepay.io/kyc/doc.pdf',
        fileName: 'doc.pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
      }),
    )
    expect(badType.status).toBe(400)

    const badMime = await POST(
      makePostRequest({
        documentType: 'passport',
        fileUrl: 'https://cdn.lancepay.io/kyc/doc.exe',
        fileName: 'doc.exe',
        fileSize: 1024,
        mimeType: 'application/x-msdownload',
      }),
    )
    expect(badMime.status).toBe(400)

    const tooLarge = await POST(
      makePostRequest({
        documentType: 'passport',
        fileUrl: 'https://cdn.lancepay.io/kyc/big.pdf',
        fileName: 'big.pdf',
        fileSize: 20 * 1024 * 1024,
        mimeType: 'application/pdf',
      }),
    )
    expect(tooLarge.status).toBe(400)
  })

  it('returns 409 when KYC application is already approved', async () => {
    mockPrisma.kycApplication.findUnique.mockResolvedValueOnce({
      id: 'app-1',
      userId: 'user-1',
      status: 'approved',
    })

    const res = await POST(
      makePostRequest({
        documentType: 'passport',
        fileUrl: 'https://cdn.lancepay.io/kyc/passport.pdf',
        fileName: 'passport.pdf',
        fileSize: 204800,
        mimeType: 'application/pdf',
      }),
    )
    expect(res.status).toBe(409)
  })

  it('returns 409 when an active document of the same type already exists', async () => {
    mockPrisma.kycDocument.findFirst.mockResolvedValueOnce({
      id: 'doc-existing',
      userId: 'user-1',
      documentType: 'passport',
      status: 'under_review',
    })

    const res = await POST(
      makePostRequest({
        documentType: 'passport',
        fileUrl: 'https://cdn.lancepay.io/kyc/passport.pdf',
        fileName: 'passport.pdf',
        fileSize: 204800,
        mimeType: 'application/pdf',
      }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.existingDocumentId).toBe('doc-existing')
  })

  it('creates a KYC document record and returns 201', async () => {
    mockPrisma.kycDocument.create.mockResolvedValueOnce({
      id: 'doc-new',
      userId: 'user-1',
      documentType: 'passport',
      status: 'uploaded',
      fileUrl: 'https://cdn.lancepay.io/kyc/passport.pdf',
      fileName: 'passport.pdf',
      fileSize: 512000,
      mimeType: 'application/pdf',
      notes: 'Bio page scan',
      createdAt: new Date('2026-03-01T12:00:00Z'),
    })

    const res = await POST(
      makePostRequest({
        documentType: 'passport',
        fileUrl: 'https://cdn.lancepay.io/kyc/passport.pdf',
        fileName: 'passport.pdf',
        fileSize: 512000,
        mimeType: 'application/pdf',
        notes: 'Bio page scan',
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.document.id).toBe('doc-new')
    expect(body.document.status).toBe('uploaded')
  })
})

describe('GET /api/kyc-documents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'user-1',
      email: 'user@lancepay.io',
      role: 'user',
    })
  })

  it('returns 403 when non-admin requests another user documents', async () => {
    const res = await GET(makeGetRequest('userId=user-2'))
    expect(res.status).toBe(403)
  })

  it('returns the authenticated user KYC documents', async () => {
    mockPrisma.kycDocument.findMany.mockResolvedValueOnce([
      {
        id: 'doc-1',
        userId: 'user-1',
        documentType: 'passport',
        status: 'verified',
        fileUrl: 'https://cdn.lancepay.io/kyc/passport.pdf',
        fileName: 'passport.pdf',
        fileSize: 512000,
        mimeType: 'application/pdf',
      },
    ])

    const res = await GET(makeGetRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.documents).toHaveLength(1)
    expect(body.total).toBe(1)
  })
})
