import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    dispute: {
      findUnique: vi.fn(),
    },
    disputeMessage: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { GET, POST } from './route'

const OPEN_DISPUTE = {
  id: 'disp-1',
  status: 'open',
  initiatorEmail: 'client@acme.com',
  invoice: {
    clientEmail: 'client@acme.com',
    user: { email: 'freelancer@lancepay.io' },
  },
}

function makePostRequest(
  disputeId: string,
  body: unknown,
  token: string | null = 'valid-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(`http://localhost/api/disputes/${disputeId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function makeGetRequest(
  disputeId: string,
  params = '',
  token: string | null = 'valid-token',
): NextRequest {
  const url = `http://localhost/api/disputes/${disputeId}/messages${params ? `?${params}` : ''}`
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(url, { method: 'GET', headers })
}

describe('POST /api/disputes/[id]/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-freelancer' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-freelancer',
      email: 'freelancer@lancepay.io',
    })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(
      makePostRequest('disp-1', { message: 'Hello' }, null),
      { params: { id: 'disp-1' } },
    )
    expect(res.status).toBe(401)
  })

  it('rejects new messages on a resolved or closed dispute with 409', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValueOnce({
      ...OPEN_DISPUTE,
      status: 'resolved',
    })

    const res = await POST(
      makePostRequest('disp-1', { message: 'Following up after resolution' }),
      { params: { id: 'disp-1' } },
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('resolved')
  })

  it('validates senderType against allowed set and rejects third-party senderEmail', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(OPEN_DISPUTE)

    const badSenderType = await POST(
      makePostRequest('disp-1', {
        message: 'Test message',
        senderType: 'bot_agent',
      }),
      { params: { id: 'disp-1' } },
    )
    expect(badSenderType.status).toBe(400)

    const wrongEmail = await POST(
      makePostRequest('disp-1', {
        message: 'Test message',
        senderType: 'freelancer',
        senderEmail: 'intruder@evil.com',
      }),
      { params: { id: 'disp-1' } },
    )
    expect(wrongEmail.status).toBe(403)
  })

  it('creates a dispute message when posted by a valid dispute party', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValueOnce(OPEN_DISPUTE)
    mockPrisma.disputeMessage.create.mockImplementationOnce(async ({ data }) => ({
      id: 'msg-1',
      createdAt: new Date('2026-03-01T12:00:00Z'),
      ...data,
    }))

    const res = await POST(
      makePostRequest('disp-1', {
        senderType: 'freelancer',
        senderEmail: 'freelancer@lancepay.io',
        message: 'Deliverables were uploaded on Feb 28.',
        attachments: ['https://cdn.lancepay.io/proof.pdf'],
      }),
      { params: { id: 'disp-1' } },
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.message).toMatchObject({
      id: 'msg-1',
      disputeId: 'disp-1',
      senderType: 'freelancer',
      senderEmail: 'freelancer@lancepay.io',
      message: 'Deliverables were uploaded on Feb 28.',
    })
  })
})

describe('GET /api/disputes/[id]/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-client' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-client',
      email: 'client@acme.com',
    })
  })

  it('returns messages ordered by createdAt ascending with pagination support', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValueOnce(OPEN_DISPUTE)
    mockPrisma.disputeMessage.findMany.mockResolvedValueOnce([
      {
        id: 'msg-1',
        disputeId: 'disp-1',
        senderType: 'client',
        senderEmail: 'client@acme.com',
        message: 'First message',
        createdAt: new Date('2026-03-01T10:00:00Z'),
      },
      {
        id: 'msg-2',
        disputeId: 'disp-1',
        senderType: 'freelancer',
        senderEmail: 'freelancer@lancepay.io',
        message: 'Second message',
        createdAt: new Date('2026-03-01T10:05:00Z'),
      },
      {
        id: 'msg-3',
        disputeId: 'disp-1',
        senderType: 'client',
        senderEmail: 'client@acme.com',
        message: 'Third message',
        createdAt: new Date('2026-03-01T10:10:00Z'),
      },
    ])

    const res = await GET(makeGetRequest('disp-1', 'limit=2'), {
      params: { id: 'disp-1' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].id).toBe('msg-1')
    expect(body.messages[1].id).toBe('msg-2')
    expect(body.nextCursor).toBe('msg-2')
    expect(mockPrisma.disputeMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { disputeId: 'disp-1' },
        orderBy: { createdAt: 'asc' },
        take: 3,
      }),
    )
  })
})
