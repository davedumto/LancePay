import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

interface AssessmentRow {
  id: string
  entityType: string
  entityId: string
  riskScore: number
  signals: unknown
  status: string
  createdAt: Date
}

const store = vi.hoisted((): { rows: AssessmentRow[] } => ({ rows: [] }))

// The route issues two hand-written SQL statements (latest-per-entity, then
// filtered/paginated; and the matching count). We emulate both against the
// in-memory store rather than parsing SQL, keyed off which one text mentions
// "COUNT(*)".
vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const sql = strings.join('?')
      const latestPerEntity = new Map<string, AssessmentRow>()
      for (const row of [...store.rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
        latestPerEntity.set(`${row.entityType}:${row.entityId}`, row)
      }
      const flagged = [...latestPerEntity.values()].filter((r) => r.status === 'flagged')

      if (sql.includes('COUNT(*)')) {
        return [{ count: BigInt(flagged.length) }]
      }

      const sorted = flagged.sort((a, b) => {
        if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore
        return b.createdAt.getTime() - a.createdAt.getTime()
      })
      const limit = vals[0] as number
      const offset = vals[1] as number
      return sorted.slice(offset, offset + limit)
    }),
  },
}))

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/app/api/_lib/compliance-auth', () => ({
  requireComplianceActor: vi.fn(async () => ({ actor: { id: 'compliance-1', role: 'compliance', email: 'c@x.com' } })),
}))

import { GET } from './route'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

function row(overrides: Partial<AssessmentRow>): AssessmentRow {
  return {
    id: `r-${Math.random()}`,
    entityType: 'user',
    entityId: 'user-1',
    riskScore: 50,
    signals: {},
    status: 'logged',
    createdAt: new Date(),
    ...overrides,
  }
}

function getReq(query = '') {
  return new NextRequest(`http://localhost/api/risk-assessments/flagged${query}`, {
    headers: { authorization: 'Bearer tok' },
  })
}

describe('GET /api/risk-assessments/flagged', () => {
  beforeEach(() => {
    store.rows = []
    vi.clearAllMocks()
    ;(requireComplianceActor as ReturnType<typeof vi.fn>).mockResolvedValue({
      actor: { id: 'compliance-1', role: 'compliance', email: 'c@x.com' },
    })
  })

  it('returns only entities whose latest assessment is flagged', async () => {
    // user-1 was flagged, then later cleared -> should NOT appear.
    store.rows.push(row({ entityId: 'user-1', status: 'flagged', riskScore: 90, createdAt: new Date('2026-01-01') }))
    store.rows.push(row({ entityId: 'user-1', status: 'cleared', riskScore: 5, createdAt: new Date('2026-01-02') }))
    // user-2 is currently flagged.
    store.rows.push(row({ entityId: 'user-2', status: 'flagged', riskScore: 75, createdAt: new Date('2026-01-01') }))

    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.assessments).toHaveLength(1)
    expect(json.assessments[0].entityId).toBe('user-2')
  })

  it('deduplicates to one row per entityType + entityId pair', async () => {
    store.rows.push(row({ entityId: 'user-1', status: 'flagged', riskScore: 60, createdAt: new Date('2026-01-01') }))
    store.rows.push(row({ entityId: 'user-1', status: 'flagged', riskScore: 95, createdAt: new Date('2026-01-05') }))

    const res = await GET(getReq())
    const json = await res.json()
    expect(json.assessments).toHaveLength(1)
    expect(json.assessments[0].riskScore).toBe(95)
  })

  it('sorts by riskScore descending', async () => {
    store.rows.push(row({ entityId: 'user-1', status: 'flagged', riskScore: 40 }))
    store.rows.push(row({ entityId: 'user-2', status: 'flagged', riskScore: 90 }))
    store.rows.push(row({ entityId: 'user-3', status: 'flagged', riskScore: 70 }))

    const res = await GET(getReq())
    const json = await res.json()
    expect(json.assessments.map((a: AssessmentRow) => a.entityId)).toEqual(['user-2', 'user-3', 'user-1'])
  })

  it('paginates results', async () => {
    for (let i = 0; i < 5; i++) {
      store.rows.push(row({ entityId: `user-${i}`, status: 'flagged', riskScore: 100 - i }))
    }
    const res = await GET(getReq('?page=2&pageSize=2'))
    const json = await res.json()
    expect(json.assessments).toHaveLength(2)
    expect(json.pagination).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 })
  })

  it('returns an empty list when nothing is flagged', async () => {
    store.rows.push(row({ entityId: 'user-1', status: 'cleared' }))
    const res = await GET(getReq())
    const json = await res.json()
    expect(json.assessments).toHaveLength(0)
    expect(json.pagination.total).toBe(0)
  })

  it('rejects a non-integer pageSize', async () => {
    const res = await GET(getReq('?pageSize=-1'))
    expect(res.status).toBe(400)
  })

  it('returns 403 when the actor lacks a compliance role', async () => {
    ;(requireComplianceActor as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    })
    const res = await GET(getReq())
    expect(res.status).toBe(403)
  })

  it('returns 401 when the actor is unauthenticated', async () => {
    ;(requireComplianceActor as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    })
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })
})
