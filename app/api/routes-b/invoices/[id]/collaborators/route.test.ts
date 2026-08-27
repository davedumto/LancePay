import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    invoiceCollaborator: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'owner-user-123'
const mockPrivyId = 'privy-owner-123'
const mockInvoiceId = 'inv-456'
const mockSubId = 'sub-user-789'
const params = { id: mockInvoiceId }

function makeGetRequest(invoiceId = mockInvoiceId, token = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost:3000/api/routes-b/invoices/${invoiceId}/collaborators`, { headers })
}

function makePostRequest(body: unknown, invoiceId = mockInvoiceId, token = 'valid-token') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost:3000/api/routes-b/invoices/${invoiceId}/collaborators`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('Invoice Collaborators API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
    vi.mocked(prisma.user.findUnique).mockImplementation(async ({ where }: { where: { privyId?: string; id?: string; email?: string } }) => {
      if (where.privyId === mockPrivyId || where.id === mockUserId) {
        return { id: mockUserId, email: 'owner@example.com' } as never
      }
      if (where.id === mockSubId || where.email === 'sub@example.com') {
        return { id: mockSubId, email: 'sub@example.com' } as never
      }
      return null as never
    })
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({
      id: mockInvoiceId,
      amount: 1000,
      currency: 'USD',
      status: 'pending',
    } as never)
  })

  describe('GET /api/routes-b/invoices/[id]/collaborators', () => {
    it('returns the list of collaborators on the invoice', async () => {
      const mockCollaborators = [
        {
          id: 'collab-1',
          invoiceId: mockInvoiceId,
          subContractorId: mockSubId,
          sharePercentage: 25,
          payoutStatus: 'pending',
          paymentSource: 'payment',
          subContractor: {
            id: mockSubId,
            name: 'Sub Contractor',
            email: 'sub@example.com',
            avatarUrl: null,
          },
        },
      ]
      vi.mocked(prisma.invoiceCollaborator.findMany).mockResolvedValue(mockCollaborators as never)

      const res = await GET(makeGetRequest(), { params })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.collaborators).toHaveLength(1)
      expect(data.collaborators[0].subContractorId).toBe(mockSubId)
      expect(data.collaborators[0].sharePercentage).toBe(25)
    })

    it('returns 401 when unauthorized', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await GET(makeGetRequest(), { params })
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Unauthorized')
    })

    it('returns 404 when invoice is not found or not owned by user', async () => {
      vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
      const res = await GET(makeGetRequest(), { params })
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('Invoice not found')
    })

    it('returns 500 when database throws an error', async () => {
      vi.mocked(prisma.invoiceCollaborator.findMany).mockRejectedValue(new Error('DB error'))
      const res = await GET(makeGetRequest(), { params })
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Failed to fetch invoice collaborators')
    })
  })

  describe('POST /api/routes-b/invoices/[id]/collaborators', () => {
    it('creates a new collaborator by subContractorId', async () => {
      vi.mocked(prisma.invoiceCollaborator.findMany).mockResolvedValue([])
      vi.mocked(prisma.invoiceCollaborator.create).mockResolvedValue({
        id: 'collab-new',
        invoiceId: mockInvoiceId,
        subContractorId: mockSubId,
        sharePercentage: 30,
        payoutStatus: 'pending',
        paymentSource: 'payment',
        subContractor: {
          id: mockSubId,
          name: 'Sub Contractor',
          email: 'sub@example.com',
          avatarUrl: null,
        },
      } as never)

      const res = await POST(
        makePostRequest({ subContractorId: mockSubId, sharePercentage: 30 }),
        { params },
      )
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.collaborator.id).toBe('collab-new')
      expect(data.collaborator.sharePercentage).toBe(30)
    })

    it('creates a new collaborator by subcontractor email', async () => {
      vi.mocked(prisma.invoiceCollaborator.findMany).mockResolvedValue([])
      vi.mocked(prisma.invoiceCollaborator.create).mockResolvedValue({
        id: 'collab-new-2',
        invoiceId: mockInvoiceId,
        subContractorId: mockSubId,
        sharePercentage: 20,
        payoutStatus: 'pending',
        paymentSource: 'payment',
        subContractor: {
          id: mockSubId,
          name: 'Sub Contractor',
          email: 'sub@example.com',
          avatarUrl: null,
        },
      } as never)

      const res = await POST(
        makePostRequest({ email: 'sub@example.com', sharePercentage: 20 }),
        { params },
      )
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.collaborator.subContractorId).toBe(mockSubId)
    })

    it('returns 400 when sharePercentage is missing or invalid', async () => {
      const res1 = await POST(makePostRequest({ subContractorId: mockSubId }), { params })
      expect(res1.status).toBe(400)

      const res2 = await POST(makePostRequest({ subContractorId: mockSubId, sharePercentage: -5 }), { params })
      expect(res2.status).toBe(400)

      const res3 = await POST(makePostRequest({ subContractorId: mockSubId, sharePercentage: 105 }), { params })
      expect(res3.status).toBe(400)
    })

    it('returns 400 when neither subContractorId nor email is provided', async () => {
      const res = await POST(makePostRequest({ sharePercentage: 20 }), { params })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('subContractorId or email is required')
    })

    it('returns 404 when subcontractor user does not exist', async () => {
      const res = await POST(
        makePostRequest({ subContractorId: 'non-existent-user', sharePercentage: 20 }),
        { params },
      )
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('Subcontractor user not found')
    })

    it('returns 400 when trying to add the owner as collaborator', async () => {
      const res = await POST(
        makePostRequest({ subContractorId: mockUserId, sharePercentage: 20 }),
        { params },
      )
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Cannot add invoice owner as a collaborator')
    })

    it('returns 409 when collaborator is already added to invoice', async () => {
      vi.mocked(prisma.invoiceCollaborator.findMany).mockResolvedValue([
        { subContractorId: mockSubId, sharePercentage: 20 },
      ] as never)

      const res = await POST(
        makePostRequest({ subContractorId: mockSubId, sharePercentage: 20 }),
        { params },
      )
      expect(res.status).toBe(409)
      const data = await res.json()
      expect(data.error).toContain('Collaborator already added to this invoice')
    })

    it('returns 400 when total share percentage exceeds 100%', async () => {
      vi.mocked(prisma.invoiceCollaborator.findMany).mockResolvedValue([
        { subContractorId: 'other-sub', sharePercentage: 80 },
      ] as never)

      const res = await POST(
        makePostRequest({ subContractorId: mockSubId, sharePercentage: 30 }),
        { params },
      )
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Total collaborator share cannot exceed 100%')
    })

    it('returns 401 when unauthorized', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await POST(
        makePostRequest({ subContractorId: mockSubId, sharePercentage: 20 }),
        { params },
      )
      expect(res.status).toBe(401)
    })

    it('returns 404 when invoice is not found', async () => {
      vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
      const res = await POST(
        makePostRequest({ subContractorId: mockSubId, sharePercentage: 20 }),
        { params },
      )
      expect(res.status).toBe(404)
    })

    it('returns 500 when database throws an error', async () => {
      vi.mocked(prisma.invoiceCollaborator.findMany).mockRejectedValue(new Error('DB error'))
      const res = await POST(
        makePostRequest({ subContractorId: mockSubId, sharePercentage: 20 }),
        { params },
      )
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Failed to add invoice collaborator')
    })
  })
})
