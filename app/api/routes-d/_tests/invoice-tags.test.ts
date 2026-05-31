import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import { POST, DELETE } from '../invoices/[id]/tags/route'

// Test Helpers 

const TEST_USER_PRIVY_ID = 'test-user-invoice-tags-001'
const TEST_USER_EMAIL = 'test-tags@lancepay.dev'

let testUserId: string
let testInvoiceId: string
let testTagId: string
let testTag2Id: string
let authToken: string

async function createTestUser() {
  const user = await prisma.user.upsert({
    where: { privyId: TEST_USER_PRIVY_ID },
    update: {},
    create: {
      privyId: TEST_USER_PRIVY_ID,
      email: TEST_USER_EMAIL,
      name: 'Test User Tags',
    },
  })
  testUserId = user.id
  return user
}

async function createTestInvoice(userId: string) {
  const invoice = await prisma.invoice.create({
    data: {
      userId,
      invoiceNumber: `INV-TAGS-${Date.now()}`,
      clientEmail: 'client@example.com',
      clientName: 'Test Client',
      description: 'Test invoice for tags',
      amount: 100.00,
      currency: 'USD',
      paymentLink: `https://lancepay.dev/pay/test-tags-${Date.now()}`,
    },
  })
  return invoice
}

async function createTestTag(userId: string, name: string, color = '#6366f1') {
  const tag = await prisma.tag.create({
    data: {
      userId,
      name: `${name}-${Date.now()}`,
      color,
    },
  })
  return tag
}

function mockRequest(method: 'POST' | 'DELETE', bodyOrQuery: unknown, invoiceId: string): Request {
  const url = method === 'POST'
    ? `http://localhost:3000/api/routes-d/invoices/${invoiceId}/tags`
    : `http://localhost:3000/api/routes-d/invoices/${invoiceId}/tags?tagId=${bodyOrQuery}`

  const init: RequestInit = {
    method,
    headers: {
      'authorization': 'Bearer test-token',
      'content-type': 'application/json',
    },
  }

  if (method === 'POST' && bodyOrQuery) {
    init.body = JSON.stringify(bodyOrQuery)
  }

  return new Request(url, init)
}

// Mock Auth 

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(async (token: string) => {
    if (token === 'test-token') {
      return { userId: TEST_USER_PRIVY_ID }
    }
    return null
  }),
}))

// Test Suite 

describe('Invoice Tags Flow', () => {
  beforeAll(async () => {
    await createTestUser()
    const invoice = await createTestInvoice(testUserId)
    testInvoiceId = invoice.id

    const tag1 = await createTestTag(testUserId, 'urgent')
    testTagId = tag1.id

    const tag2 = await createTestTag(testUserId, 'paid')
    testTag2Id = tag2.id
  })

  afterAll(async () => {
    // Cleanup
    await prisma.invoiceTag.deleteMany({
      where: { invoiceId: testInvoiceId },
    })
    await prisma.invoice.deleteMany({
      where: { id: testInvoiceId },
    })
    await prisma.tag.deleteMany({
      where: { userId: testUserId },
    })
    await prisma.user.deleteMany({
      where: { privyId: TEST_USER_PRIVY_ID },
    })
  })

  beforeEach(async () => {
    // Clear tags before each test
    await prisma.invoiceTag.deleteMany({
      where: { invoiceId: testInvoiceId },
    })
  })

  // POST / Attach 

  describe('POST — Attach Tag', () => {
    it('attaches a tag to an invoice (201)', async () => {
      const req = mockRequest('POST', { tagId: testTagId }, testInvoiceId)
      const res = await POST(req as any, { params: Promise.resolve({ id: testInvoiceId }) })
      
      expect(res.status).toBe(201)
      
      const body = await res.json()
      expect(body).toMatchObject({
        invoiceId: testInvoiceId,
        tagId: testTagId,
        tagName: expect.any(String),
        tagColor: expect.any(String),
      })

      // Verify in DB
      const link = await prisma.invoiceTag.findUnique({
        where: { invoiceId_tagId: { invoiceId: testInvoiceId, tagId: testTagId } },
      })
      expect(link).not.toBeNull()
    })

    it('is idempotent — returns 200 on duplicate attach', async () => {
      // First attach
      const req1 = mockRequest('POST', { tagId: testTagId }, testInvoiceId)
      await POST(req1 as any, { params: Promise.resolve({ id: testInvoiceId }) })

      // Second attach (same tag)
      const req2 = mockRequest('POST', { tagId: testTagId }, testInvoiceId)
      const res = await POST(req2 as any, { params: Promise.resolve({ id: testInvoiceId }) })

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.tagId).toBe(testTagId)

      // Should still only have one link
      const count = await prisma.invoiceTag.count({
        where: { invoiceId: testInvoiceId, tagId: testTagId },
      })
      expect(count).toBe(1)
    })

    it('returns 401 without auth token', async () => {
      const req = new Request(
        `http://localhost:3000/api/routes-d/invoices/${testInvoiceId}/tags`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tagId: testTagId }),
        }
      )

      const res = await POST(req as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(res.status).toBe(401)
    })

    it('returns 400 when tagId is missing', async () => {
      const req = mockRequest('POST', {}, testInvoiceId)
      const res = await POST(req as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(res.status).toBe(400)
      
      const body = await res.json()
      expect(body.error).toContain('tagId is required')
    })

    it('returns 400 when tagId is empty string', async () => {
      const req = mockRequest('POST', { tagId: '   ' }, testInvoiceId)
      const res = await POST(req as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(res.status).toBe(400)
    })

    it('returns 404 when invoice does not exist', async () => {
      const req = mockRequest('POST', { tagId: testTagId }, 'non-existent-id')
      const res = await POST(req as any, { params: Promise.resolve({ id: 'non-existent-id' }) })
      expect(res.status).toBe(404)
    })

    it('returns 403 when invoice belongs to another user', async () => {
      // Create another user and their invoice
      const otherUser = await prisma.user.create({
        data: {
          privyId: 'other-user-tags',
          email: 'other@lancepay.dev',
        },
      })
      const otherInvoice = await createTestInvoice(otherUser.id)

      const req = mockRequest('POST', { tagId: testTagId }, otherInvoice.id)
      const res = await POST(req as any, { params: Promise.resolve({ id: otherInvoice.id }) })
      expect(res.status).toBe(403)

      // Cleanup
      await prisma.invoice.delete({ where: { id: otherInvoice.id } })
      await prisma.user.delete({ where: { id: otherUser.id } })
    })

    it('returns 404 when tag does not exist', async () => {
      const req = mockRequest('POST', { tagId: 'non-existent-tag' }, testInvoiceId)
      const res = await POST(req as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(res.status).toBe(404)
    })

    it('returns 403 when tag belongs to another user', async () => {
      const otherUser = await prisma.user.create({
        data: {
          privyId: 'other-user-tag-owner',
          email: 'other-tag@lancepay.dev',
        },
      })
      const otherTag = await createTestTag(otherUser.id, 'other-tag')

      const req = mockRequest('POST', { tagId: otherTag.id }, testInvoiceId)
      const res = await POST(req as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(res.status).toBe(403)

      // Cleanup
      await prisma.tag.delete({ where: { id: otherTag.id } })
      await prisma.user.delete({ where: { id: otherUser.id } })
    })

    it('allows attaching multiple different tags', async () => {
      const req1 = mockRequest('POST', { tagId: testTagId }, testInvoiceId)
      await POST(req1 as any, { params: Promise.resolve({ id: testInvoiceId }) })

      const req2 = mockRequest('POST', { tagId: testTag2Id }, testInvoiceId)
      const res = await POST(req2 as any, { params: Promise.resolve({ id: testInvoiceId }) })

      expect(res.status).toBe(201)

      const tags = await prisma.invoiceTag.findMany({
        where: { invoiceId: testInvoiceId },
      })
      expect(tags).toHaveLength(2)
    })
  })

  //  DELETE / Detach

  describe('DELETE — Detach Tag', () => {
    it('detaches a tag from an invoice (200)', async () => {
      // Setup: attach first
      await prisma.invoiceTag.create({
        data: { invoiceId: testInvoiceId, tagId: testTagId },
      })

      const req = mockRequest('DELETE', testTagId, testInvoiceId)
      const res = await DELETE(req as any, { params: Promise.resolve({ id: testInvoiceId }) })

      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toMatchObject({
        invoiceId: testInvoiceId,
        tagId: testTagId,
        detached: true,
      })

      // Verify removed from DB
      const link = await prisma.invoiceTag.findUnique({
        where: { invoiceId_tagId: { invoiceId: testInvoiceId, tagId: testTagId } },
      })
      expect(link).toBeNull()
    })

    it('returns 404 when tag was not attached', async () => {
      // Ensure no link exists
      await prisma.invoiceTag.deleteMany({
        where: { invoiceId: testInvoiceId, tagId: testTagId },
      })

      const req = mockRequest('DELETE', testTagId, testInvoiceId)
      const res = await DELETE(req as any, { params: Promise.resolve({ id: testInvoiceId }) })

      expect(res.status).toBe(404)
      
      const body = await res.json()
      expect(body.error).toContain('Tag not attached')
    })

    it('returns 400 when tagId query param is missing', async () => {
      const req = new Request(
        `http://localhost:3000/api/routes-d/invoices/${testInvoiceId}/tags`,
        {
          method: 'DELETE',
          headers: { authorization: 'Bearer test-token' },
        }
      )

      const res = await DELETE(req as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(res.status).toBe(400)
    })

    it('returns 401 without auth token', async () => {
      const req = new Request(
        `http://localhost:3000/api/routes-d/invoices/${testInvoiceId}/tags?tagId=${testTagId}`,
        { method: 'DELETE' }
      )

      const res = await DELETE(req as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(res.status).toBe(401)
    })

    it('returns 404 when invoice does not exist', async () => {
      const req = mockRequest('DELETE', testTagId, 'non-existent-id')
      const res = await DELETE(req as any, { params: Promise.resolve({ id: 'non-existent-id' }) })
      expect(res.status).toBe(404)
    })

    it('returns 403 when invoice belongs to another user', async () => {
      const otherUser = await prisma.user.create({
        data: {
          privyId: 'other-user-delete',
          email: 'other-del@lancepay.dev',
        },
      })
      const otherInvoice = await createTestInvoice(otherUser.id)

      const req = mockRequest('DELETE', testTagId, otherInvoice.id)
      const res = await DELETE(req as any, { params: Promise.resolve({ id: otherInvoice.id }) })
      expect(res.status).toBe(403)

      await prisma.invoice.delete({ where: { id: otherInvoice.id } })
      await prisma.user.delete({ where: { id: otherUser.id } })
    })

    it('returns 404 when tag does not exist', async () => {
      const req = mockRequest('DELETE', 'non-existent-tag', testInvoiceId)
      const res = await DELETE(req as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(res.status).toBe(404)
    })
  })

  // Tag Usage Counts 

  describe('Tag Usage Counts', () => {
    it('increments usage count when tag is attached', async () => {
      const beforeCount = await prisma.invoiceTag.count({
        where: { tagId: testTagId },
      })

      const req = mockRequest('POST', { tagId: testTagId }, testInvoiceId)
      await POST(req as any, { params: Promise.resolve({ id: testInvoiceId }) })

      const afterCount = await prisma.invoiceTag.count({
        where: { tagId: testTagId },
      })

      expect(afterCount).toBe(beforeCount + 1)
    })

    it('decrements usage count when tag is detached', async () => {
      // Setup
      await prisma.invoiceTag.create({
        data: { invoiceId: testInvoiceId, tagId: testTagId },
      })

      const beforeCount = await prisma.invoiceTag.count({
        where: { tagId: testTagId },
      })

      const req = mockRequest('DELETE', testTagId, testInvoiceId)
      await DELETE(req as any, { params: Promise.resolve({ id: testInvoiceId }) })

      const afterCount = await prisma.invoiceTag.count({
        where: { tagId: testTagId },
      })

      expect(afterCount).toBe(beforeCount - 1)
    })

    it('does not double-count on idempotent re-attach', async () => {
      const req = mockRequest('POST', { tagId: testTagId }, testInvoiceId)
      await POST(req as any, { params: Promise.resolve({ id: testInvoiceId }) })

      const countAfterFirst = await prisma.invoiceTag.count({
        where: { tagId: testTagId },
      })

      // Re-attach (idempotent)
      await POST(req as any, { params: Promise.resolve({ id: testInvoiceId }) })

      const countAfterSecond = await prisma.invoiceTag.count({
        where: { tagId: testTagId },
      })

      expect(countAfterSecond).toBe(countAfterFirst)
    })
  })

  //  Full Flow 

  describe('Full Attach → Detach Flow', () => {
    it('completes full attach and detach cycle', async () => {
      // Attach
      const postReq = mockRequest('POST', { tagId: testTagId }, testInvoiceId)
      const postRes = await POST(postReq as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(postRes.status).toBe(201)

      // Verify attached
      let link = await prisma.invoiceTag.findUnique({
        where: { invoiceId_tagId: { invoiceId: testInvoiceId, tagId: testTagId } },
      })
      expect(link).not.toBeNull()

      // Detach
      const deleteReq = mockRequest('DELETE', testTagId, testInvoiceId)
      const deleteRes = await DELETE(deleteReq as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(deleteRes.status).toBe(200)

      // Verify detached
      link = await prisma.invoiceTag.findUnique({
        where: { invoiceId_tagId: { invoiceId: testInvoiceId, tagId: testTagId } },
      })
      expect(link).toBeNull()
    })

    it('handles multiple tags on same invoice', async () => {
      // Attach two tags
      await prisma.invoiceTag.create({
        data: { invoiceId: testInvoiceId, tagId: testTagId },
      })
      await prisma.invoiceTag.create({
        data: { invoiceId: testInvoiceId, tagId: testTag2Id },
      })

      // Detach one
      const req = mockRequest('DELETE', testTagId, testInvoiceId)
      const res = await DELETE(req as any, { params: Promise.resolve({ id: testInvoiceId }) })
      expect(res.status).toBe(200)

      // Verify only one remains
      const remaining = await prisma.invoiceTag.findMany({
        where: { invoiceId: testInvoiceId },
      })
      expect(remaining).toHaveLength(1)
      expect(remaining[0].tagId).toBe(testTag2Id)
    })
  })
})