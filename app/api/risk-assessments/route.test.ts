import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

interface UserRow { id: string; createdAt: Date }
interface ScreeningRow { userId: string; status: string }
interface InvoiceRow { id: string; userId: string }
interface AssessmentRow {
  id: string
  entityType: string
  entityId: string
  riskScore: number
  signals: unknown
  status: string
  createdAt: Date
}

interface Store {
  users: Map<string, UserRow>
  screenings: Map<string, ScreeningRow>
  invoices: Map<string, InvoiceRow>
  transactionCounts: Map<string, number>
  assessments: AssessmentRow[]
}

const store = vi.hoisted((): { state: Store } => ({
  state: {
    users: new Map(),
    screenings: new Map(),
    invoices: new Map(),
    transactionCounts: new Map(),
    assessments: [],
  },
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.state.users.get(where.id) ?? null),
    },
    invoice: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.state.invoices.get(where.id) ?? null),
    },
    sanctionsScreening: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => store.state.screenings.get(where.userId) ?? null),
    },
    transaction: {
      count: vi.fn(async ({ where }: { where: { userId: string } }) => store.state.transactionCounts.get(where.userId) ?? 0),
    },
    riskAssessment: {
      create: vi.fn(async ({ data }: { data: Omit<AssessmentRow, 'id' | 'createdAt'> }) => {
        const row: AssessmentRow = {
          id: `assessment-${store.state.assessments.length + 1}`,
          createdAt: new Date(),
          ...data,
        }
        store.state.assessments.push(row)
        return row
      }),
      count: vi.fn(async () => store.state.assessments.length),
      findMany: vi.fn(async () => [...store.state.assessments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())),
    },
  },
}))

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/app/api/_lib/compliance-auth', () => ({
  requireComplianceActor: vi.fn(async () => ({ actor: { id: 'compliance-1', role: 'compliance', email: 'c@x.com' } })),
}))

import { GET, POST } from './route'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/risk-assessments', {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getReq(query = '') {
  return new NextRequest(`http://localhost/api/risk-assessments${query}`, {
    headers: { authorization: 'Bearer tok' },
  })
}

describe('POST /api/risk-assessments', () => {
  beforeEach(() => {
    store.state = { users: new Map(), screenings: new Map(), invoices: new Map(), transactionCounts: new Map(), assessments: [] }
    vi.clearAllMocks()
    ;(requireComplianceActor as ReturnType<typeof vi.fn>).mockResolvedValue({
      actor: { id: 'compliance-1', role: 'compliance', email: 'c@x.com' },
    })
  })

  it('scores a clean, aged user as cleared', async () => {
    store.state.users.set('user-1', { id: 'user-1', createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) })
    store.state.screenings.set('user-1', { userId: 'user-1', status: 'clear' })
    store.state.transactionCounts.set('user-1', 0)

    const res = await POST(postReq({ entityType: 'user', entityId: 'user-1' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.assessment.status).toBe('cleared')
    expect(json.assessment.riskScore).toBeGreaterThanOrEqual(0)
    expect(json.assessment.riskScore).toBeLessThanOrEqual(100)
    expect(json.assessment.signals.sanctionsStatus.status).toBe('clear')
  })

  it('flags a sanctioned, high-velocity, brand-new user', async () => {
    store.state.users.set('user-2', { id: 'user-2', createdAt: new Date() })
    store.state.screenings.set('user-2', { userId: 'user-2', status: 'flagged' })
    store.state.transactionCounts.set('user-2', 10)

    const res = await POST(postReq({ entityType: 'user', entityId: 'user-2' }))
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.assessment.status).toBe('flagged')
    expect(json.assessment.riskScore).toBeLessThanOrEqual(100)
  })

  it('never produces a score outside the documented [0, 100] range', async () => {
    store.state.users.set('user-3', { id: 'user-3', createdAt: new Date() })
    store.state.screenings.set('user-3', { userId: 'user-3', status: 'flagged' })
    store.state.transactionCounts.set('user-3', 999)

    const res = await POST(postReq({ entityType: 'user', entityId: 'user-3' }))
    const json = await res.json()
    expect(json.assessment.riskScore).toBeLessThanOrEqual(100)
    expect(json.assessment.riskScore).toBeGreaterThanOrEqual(0)
  })

  it('resolves entityType "invoice" via the invoice owner', async () => {
    store.state.users.set('user-4', { id: 'user-4', createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) })
    store.state.invoices.set('inv-1', { id: 'inv-1', userId: 'user-4' })
    store.state.screenings.set('user-4', { userId: 'user-4', status: 'under_review' })
    store.state.transactionCounts.set('user-4', 1)

    const res = await POST(postReq({ entityType: 'invoice', entityId: 'inv-1' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.assessment.entityType).toBe('invoice')
    expect(json.assessment.entityId).toBe('inv-1')
    expect(json.assessment.signals.userId).toBe('user-4')
  })

  it('rejects an entityType outside the allowed list', async () => {
    const res = await POST(postReq({ entityType: 'wallet', entityId: 'user-1' }))
    expect(res.status).toBe(400)
  })

  it('rejects a missing entityId', async () => {
    const res = await POST(postReq({ entityType: 'user' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when the user does not exist', async () => {
    const res = await POST(postReq({ entityType: 'user', entityId: 'ghost' }))
    expect(res.status).toBe(404)
  })

  it('returns 404 when the invoice does not exist', async () => {
    const res = await POST(postReq({ entityType: 'invoice', entityId: 'ghost-invoice' }))
    expect(res.status).toBe(404)
  })

  it('treats an unscreened user as a mild (not severe) signal', async () => {
    store.state.users.set('user-5', { id: 'user-5', createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) })
    store.state.transactionCounts.set('user-5', 0)

    const res = await POST(postReq({ entityType: 'user', entityId: 'user-5' }))
    const json = await res.json()
    expect(json.assessment.signals.sanctionsStatus.status).toBe('unscreened')
    expect(json.assessment.status).not.toBe('flagged')
  })

  it('returns 403 when the actor lacks a compliance role', async () => {
    ;(requireComplianceActor as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    })
    const res = await POST(postReq({ entityType: 'user', entityId: 'user-1' }))
    expect(res.status).toBe(403)
  })

  it('rejects invalid JSON', async () => {
    const req = new NextRequest('http://localhost/api/risk-assessments', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: '{not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/risk-assessments', () => {
  beforeEach(() => {
    store.state = { users: new Map(), screenings: new Map(), invoices: new Map(), transactionCounts: new Map(), assessments: [] }
    vi.clearAllMocks()
    ;(requireComplianceActor as ReturnType<typeof vi.fn>).mockResolvedValue({
      actor: { id: 'compliance-1', role: 'compliance', email: 'c@x.com' },
    })
  })

  it('lists assessments with pagination metadata', async () => {
    store.state.assessments.push({
      id: 'a1', entityType: 'user', entityId: 'user-1', riskScore: 10, signals: {}, status: 'cleared', createdAt: new Date(),
    })
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.assessments).toHaveLength(1)
    expect(json.pagination.total).toBe(1)
  })

  it('rejects a non-integer page', async () => {
    const res = await GET(getReq('?page=abc'))
    expect(res.status).toBe(400)
  })

  it('returns 403 when the actor lacks a compliance role', async () => {
    ;(requireComplianceActor as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    })
    const res = await GET(getReq())
    expect(res.status).toBe(403)
  })
})
