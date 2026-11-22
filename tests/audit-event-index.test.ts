import crypto from 'crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindUnique = vi.fn()
const auditEventFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findUnique: invoiceFindUnique },
    auditEvent: { findMany: auditEventFindMany },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/invoices/inv-1/audit-events'
const SECRET = 'audit-test-secret'

function req(token: string | null = 'tok') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'GET', headers })
}

const ctx = { params: Promise.resolve({ id: 'inv-1' }) }

function signedEvent(id: string, metadata: Record<string, unknown>, createdAt: string) {
  return {
    id,
    invoiceId: 'inv-1',
    eventType: 'sent',
    actorId: 'user-1',
    metadata,
    signature: createHmacSha256(SECRET, JSON.stringify(metadata)),
    createdAt: new Date(createdAt),
  }
}

function createHmacSha256(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

describe('AuditEvent ordered-read indexes (#1915)', () => {
  it('declares composite and actor indexes in the Prisma schema', () => {
    const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    const model = schema.slice(schema.indexOf('model AuditEvent {'), schema.indexOf('model SavingsGoal {'))
    expect(model).toContain('@@index([invoiceId, createdAt])')
    expect(model).toContain('@@index([actorId])')
  })

  it('migrates the invoice-only index to the composite index', () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20261122150000_add_audit_event_ordering_indexes/migration.sql',
      ),
      'utf8',
    )
    expect(migration).toContain('DROP INDEX IF EXISTS "AuditEvent_invoiceId_idx"')
    expect(migration).toContain(
      'CREATE INDEX "AuditEvent_invoiceId_createdAt_idx" ON "AuditEvent"("invoiceId", "createdAt")',
    )
    expect(migration).toContain('CREATE INDEX "AuditEvent_actorId_idx" ON "AuditEvent"("actorId")')
  })
})

describe('GET /api/invoices/[id]/audit-events ordered reads (#1915)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AUDIT_SIGNING_SECRET = SECRET
  })

  it('reads one invoice in createdAt order using the composite index shape', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-1', userId: 'user-1', clientId: 'client-1' })
    const events = [
      signedEvent('evt-1', { step: 1 }, '2026-01-01'),
      signedEvent('evt-2', { step: 2 }, '2026-01-02'),
    ]
    auditEventFindMany.mockResolvedValue(events)

    const { GET } = await import('@/app/api/invoices/[id]/audit-events/route')
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)

    const query = auditEventFindMany.mock.calls[0]![0]
    expect(query.where).toEqual({ invoiceId: 'inv-1' })
    expect(query.orderBy).toEqual({ createdAt: 'asc' })

    const body = await res.json()
    expect(body.events.map((event: { id: string }) => event.id)).toEqual(['evt-1', 'evt-2'])
    expect(body.events.every((event: { verified: boolean }) => event.verified)).toBe(true)
    expect(body.events[0].createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('keeps the invoice filter when a client is restricted to non-internal events', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'client-1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-1', userId: 'user-1', clientId: 'client-1' })
    auditEventFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/invoices/[id]/audit-events/route')
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)

    const query = auditEventFindMany.mock.calls[0]![0]
    expect(query.where).toEqual({
      invoiceId: 'inv-1',
      eventType: { not: { startsWith: 'internal.' } },
    })
    expect(query.orderBy).toEqual({ createdAt: 'asc' })
  })

  it('returns 500 when the ordered audit read fails', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv-1', userId: 'user-1', clientId: 'client-1' })
    auditEventFindMany.mockRejectedValue(new Error('database unavailable'))

    const { GET } = await import('@/app/api/invoices/[id]/audit-events/route')
    const res = await GET(req(), ctx)
    expect(res.status).toBe(500)
    expect(auditEventFindMany).toHaveBeenCalledTimes(1)
  })
})
