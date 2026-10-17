import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { generateSignature } from '@/lib/audit'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    invoice: {
      findUnique: vi.fn(),
    },
    auditEvent: {
      findMany: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { GET } from './route'

function makeGetRequest(
  invoiceId: string,
  params = '',
  token: string | null = 'valid-token',
): NextRequest {
  const url = `http://localhost/api/invoices/${invoiceId}/audit-events${params ? `?${params}` : ''}`
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(url, { method: 'GET', headers })
}

const INVOICE = {
  id: 'inv-1',
  userId: 'owner-1',
  clientId: 'client-1',
  clientEmail: 'client@acme.com',
}

describe('GET /api/invoices/[id]/audit-events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-owner' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'owner-1',
      email: 'owner@lancepay.io',
    })
  })

  it('returns 401 when unauthenticated and 403 for unrelated third-party user', async () => {
    const res401 = await GET(makeGetRequest('inv-1', '', null), {
      params: { id: 'inv-1' },
    })
    expect(res401.status).toBe(401)

    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'stranger-1',
      email: 'stranger@evil.com',
    })
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(INVOICE)

    const res403 = await GET(makeGetRequest('inv-1'), {
      params: { id: 'inv-1' },
    })
    expect(res403.status).toBe(403)
  })

  it('orders events by createdAt ascending and verifies valid vs tampered signatures', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(INVOICE)

    const t1 = new Date('2026-03-01T10:00:00.000Z')
    const meta1 = { ip: '192.168.1.10', action: 'created' }
    const validSig = generateSignature('inv-1', 'invoice.created', t1.toISOString(), meta1)

    const t2 = new Date('2026-03-01T11:00:00.000Z')
    const meta2 = { amount: 9999 } // tampered metadata that doesn't match signature
    const tamperedSig = generateSignature(
      'inv-1',
      'invoice.updated',
      t2.toISOString(),
      { amount: 500 },
    )

    mockPrisma.auditEvent.findMany.mockResolvedValueOnce([
      {
        id: 'ae-1',
        invoiceId: 'inv-1',
        eventType: 'invoice.created',
        actorId: 'owner-1',
        metadata: meta1,
        signature: validSig,
        createdAt: t1,
      },
      {
        id: 'ae-2',
        invoiceId: 'inv-1',
        eventType: 'invoice.updated',
        actorId: 'owner-1',
        metadata: meta2,
        signature: tamperedSig,
        createdAt: t2,
      },
    ])

    const res = await GET(makeGetRequest('inv-1'), { params: { id: 'inv-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(mockPrisma.auditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { invoiceId: 'inv-1' },
        orderBy: { createdAt: 'asc' },
      }),
    )
    expect(body.integrityVerified).toBe(false)
    expect(body.tamperedCount).toBe(1)
    expect(body.auditEvents[0]).toMatchObject({
      id: 'ae-1',
      signatureValid: true,
      tampered: false,
    })
    expect(body.auditEvents[1]).toMatchObject({
      id: 'ae-2',
      signatureValid: false,
      tampered: true,
    })
  })

  it('filters out internal events and masks sensitive metadata when viewed by the paying client', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'client-1',
      email: 'client@acme.com',
    })
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(INVOICE)

    const t1 = new Date('2026-03-01T10:00:00.000Z')
    const publicMeta = { ip: '10.20.30.40', actorEmail: 'owner@lancepay.io' }
    const sig1 = generateSignature('inv-1', 'invoice.sent', t1.toISOString(), publicMeta)

    const t2 = new Date('2026-03-01T10:05:00.000Z')
    const internalMeta = { isInternal: true, note: 'Risk review note' }
    const sig2 = generateSignature('inv-1', 'internal.note', t2.toISOString(), internalMeta)

    mockPrisma.auditEvent.findMany.mockResolvedValueOnce([
      {
        id: 'ae-public',
        invoiceId: 'inv-1',
        eventType: 'invoice.sent',
        actorId: 'owner-1',
        metadata: publicMeta,
        signature: sig1,
        createdAt: t1,
      },
      {
        id: 'ae-internal',
        invoiceId: 'inv-1',
        eventType: 'internal.note',
        actorId: 'owner-1',
        metadata: internalMeta,
        signature: sig2,
        createdAt: t2,
      },
    ])

    const res = await GET(makeGetRequest('inv-1'), { params: { id: 'inv-1' } })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.viewerRole).toBe('client')
    expect(body.auditEvents).toHaveLength(1)
    expect(body.auditEvents[0].id).toBe('ae-public')
    // Signature verified BEFORE masking so signatureValid is still true
    expect(body.auditEvents[0].signatureValid).toBe(true)
    // Sensitive IP and email fields are masked for non-owner client
    expect(body.auditEvents[0].metadata.ip).toBe('10.20.***.***')
    expect(body.auditEvents[0].metadata.actorEmail).toBe('o***@lancepay.io')
  })
})
