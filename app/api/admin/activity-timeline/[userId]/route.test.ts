import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    auditEvent: {
      findMany: vi.fn(),
    },
    invoice: {
      findMany: vi.fn(),
    },
    withdrawalTransaction: {
      findMany: vi.fn(),
    },
    sanctionsScreening: {
      findMany: vi.fn(),
    },
    structuringFlag: {
      findMany: vi.fn(),
    },
    userSession: {
      findMany: vi.fn(),
    },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('GET /api/admin/activity-timeline/[userId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeRequest(
    userId: string,
    query = '',
    headers: Record<string, string> = { authorization: 'Bearer admin-token' },
  ) {
    return {
      req: new NextRequest(
        `http://localhost:3000/api/admin/activity-timeline/${userId}${query ? `?${query}` : ''}`,
        {
          method: 'GET',
          headers,
        },
      ),
      params: Promise.resolve({ userId }),
    }
  }

  function setupAdmin(role: 'admin' | 'superadmin' | 'user' = 'admin') {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_admin' } as any)
    ;(prisma.user.findUnique as any).mockImplementation(async ({ where }: any) => {
      if (where.privyId === 'privy_admin') {
        return {
          id: 'admin_1',
          email: 'admin@lancepay.com',
          role,
        }
      }
      if (where.id === 'user_target_123') {
        return {
          id: 'user_target_123',
          email: 'user@example.com',
        }
      }
      return null
    })
  }

  it('collates and sorts events from all ledgers in descending chronological order', async () => {
    setupAdmin('admin')

    const t1 = new Date('2026-10-18T10:00:00Z')
    const t2 = new Date('2026-10-18T11:00:00Z')
    const t3 = new Date('2026-10-18T12:00:00Z')
    const t4 = new Date('2026-10-18T13:00:00Z')

    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([
      {
        id: 'aud_1',
        eventType: 'invoice.signed',
        metadata: { ip: '192.168.1.50', signature: 'sig_secret_123' },
        createdAt: t2,
      } as any,
    ])

    vi.mocked(prisma.invoice.findMany).mockResolvedValue([
      {
        id: 'inv_1',
        invoiceNumber: 'INV-1001',
        amount: 250.0,
        currency: 'USDC',
        status: 'PAID',
        clientEmail: 'client@domain.com',
        createdAt: t4,
      } as any,
    ])

    vi.mocked(prisma.withdrawalTransaction.findMany).mockResolvedValue([
      {
        id: 'with_1',
        amount: 100.0,
        asset: 'USDC',
        status: 'completed',
        anchorId: 'yellowcard',
        createdAt: t3,
      } as any,
    ])

    vi.mocked(prisma.sanctionsScreening.findMany).mockResolvedValue([
      {
        id: 'sanc_1',
        status: 'passed',
        provider: 'persona',
        createdAt: t1,
      } as any,
    ])

    vi.mocked(prisma.structuringFlag.findMany).mockResolvedValue([])
    vi.mocked(prisma.userSession.findMany).mockResolvedValue([])

    const { req, params } = makeRequest('user_target_123')
    const res = await GET(req, { params })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.events).toHaveLength(4)

    // Verify ordering: newest first (t4 > t3 > t2 > t1)
    expect(json.events[0].id).toBe('inv_1')
    expect(json.events[1].id).toBe('with_1')
    expect(json.events[2].id).toBe('aud_1')
    expect(json.events[3].id).toBe('sanc_1')
  })

  it('masks sensitive fields for standard admin tier (tier1)', async () => {
    setupAdmin('admin')

    const t = new Date('2026-10-18T10:00:00Z')
    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([
      {
        id: 'aud_1',
        eventType: 'auth.login',
        metadata: { ip: '192.168.1.100', email: 'user@secretcompany.com', signature: 'xyz' },
        createdAt: t,
      } as any,
    ])
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([
      {
        id: 'inv_1',
        invoiceNumber: 'INV-1',
        amount: 100,
        currency: 'USD',
        status: 'SENT',
        clientEmail: 'confidential@client.com',
        createdAt: t,
      } as any,
    ])
    vi.mocked(prisma.withdrawalTransaction.findMany).mockResolvedValue([])
    vi.mocked(prisma.sanctionsScreening.findMany).mockResolvedValue([])
    vi.mocked(prisma.structuringFlag.findMany).mockResolvedValue([])
    vi.mocked(prisma.userSession.findMany).mockResolvedValue([])

    const { req, params } = makeRequest('user_target_123', '', {
      authorization: 'Bearer admin-token',
      'x-admin-tier': 'tier1',
    })
    const res = await GET(req, { params })
    const json = await res.json()

    expect(res.status).toBe(200)
    const auditEvt = json.events.find((e: any) => e.id === 'aud_1')
    expect(auditEvt.metadata.ip).toBe('192.168.***.***')
    expect(auditEvt.metadata.email).toBe('u***@secretcompany.com')
    expect(auditEvt.metadata.signature).toBe('***')

    const invEvt = json.events.find((e: any) => e.id === 'inv_1')
    expect(invEvt.metadata.clientEmail).toBe('c***@client.com')
  })

  it('preserves raw unmasked fields for superadmin tier', async () => {
    setupAdmin('superadmin')

    const t = new Date('2026-10-18T10:00:00Z')
    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([
      {
        id: 'aud_1',
        eventType: 'auth.login',
        metadata: { ip: '192.168.1.100', email: 'user@secretcompany.com', signature: 'xyz' },
        createdAt: t,
      } as any,
    ])
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([])
    vi.mocked(prisma.withdrawalTransaction.findMany).mockResolvedValue([])
    vi.mocked(prisma.sanctionsScreening.findMany).mockResolvedValue([])
    vi.mocked(prisma.structuringFlag.findMany).mockResolvedValue([])
    vi.mocked(prisma.userSession.findMany).mockResolvedValue([])

    const { req, params } = makeRequest('user_target_123', '', {
      authorization: 'Bearer admin-token',
      'x-admin-tier': 'superadmin',
    })
    const res = await GET(req, { params })
    const json = await res.json()

    expect(res.status).toBe(200)
    const auditEvt = json.events.find((e: any) => e.id === 'aud_1')
    expect(auditEvt.metadata.ip).toBe('192.168.1.100')
    expect(auditEvt.metadata.email).toBe('user@secretcompany.com')
    expect(auditEvt.metadata.signature).toBe('xyz')
  })

  it('paginates by cursor and produces nextCursor when more results exist', async () => {
    setupAdmin('admin')

    const events = Array.from({ length: 5 }, (_, i) => ({
      id: `inv_${i}`,
      invoiceNumber: `INV-${i}`,
      amount: 100,
      currency: 'USD',
      status: 'PAID',
      clientEmail: 'test@example.com',
      createdAt: new Date(Date.now() - i * 60_000),
    }))

    vi.mocked(prisma.auditEvent.findMany).mockResolvedValue([])
    vi.mocked(prisma.invoice.findMany).mockResolvedValue(events as any)
    vi.mocked(prisma.withdrawalTransaction.findMany).mockResolvedValue([])
    vi.mocked(prisma.sanctionsScreening.findMany).mockResolvedValue([])
    vi.mocked(prisma.structuringFlag.findMany).mockResolvedValue([])
    vi.mocked(prisma.userSession.findMany).mockResolvedValue([])

    // Limit to 2 items
    const { req, params } = makeRequest('user_target_123', 'limit=2')
    const res = await GET(req, { params })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.events).toHaveLength(2)
    expect(json.hasMore).toBe(true)
    expect(json.nextCursor).not.toBeNull()

    // Request second page with cursor
    const { req: req2, params: params2 } = makeRequest(
      'user_target_123',
      `limit=2&cursor=${json.nextCursor}`,
    )
    const res2 = await GET(req2, { params: params2 })
    const json2 = await res2.json()

    expect(res2.status).toBe(200)
    expect(json2.events).toHaveLength(2)
    expect(json2.events[0].id).toBe('inv_2')
  })

  it('returns 404 when target user is not found', async () => {
    setupAdmin('admin')

    const { req, params } = makeRequest('non_existent_user')
    const res = await GET(req, { params })
    expect(res.status).toBe(404)
  })

  it('returns 403 when caller is non-admin', async () => {
    setupAdmin('user')

    const { req, params } = makeRequest('user_target_123')
    const res = await GET(req, { params })
    expect(res.status).toBe(403)
  })

  it('returns 401 when caller is unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const { req, params } = makeRequest('user_target_123', '', {})
    const res = await GET(req, { params })
    expect(res.status).toBe(403)
  })

  it('returns 400 when cursor is malformed', async () => {
    setupAdmin('admin')

    const { req, params } = makeRequest('user_target_123', 'cursor=not-valid-base64')
    const res = await GET(req, { params })
    expect(res.status).toBe(400)
  })

  it('returns 500 when database throws an exception', async () => {
    setupAdmin('admin')
    vi.mocked(prisma.auditEvent.findMany).mockRejectedValue(new Error('DB failure'))

    const { req, params } = makeRequest('user_target_123')
    const res = await GET(req, { params })
    expect(res.status).toBe(500)
  })
})
