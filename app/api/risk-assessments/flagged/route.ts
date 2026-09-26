import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

// GET /api/risk-assessments/flagged — the latest assessment per
// (entityType, entityId) pair, restricted to those currently flagged.
//
// A given entity accumulates many RiskAssessment rows over time (one per
// scoring run); only the most recent one reflects its current status, so a
// naive `where: { status: 'flagged' }` would double-count entities that
// were flagged in the past but have since cleared. We instead pick the
// latest row per entity first (via DISTINCT ON, ordered by createdAt) and
// only then filter to status = 'flagged'.

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

interface LatestFlaggedRow {
  id: string
  entityType: string
  entityId: string
  riskScore: number
  signals: unknown
  status: string
  createdAt: Date
}

function parsePositiveInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    const { searchParams } = new URL(request.url)
    const page = parsePositiveInteger(searchParams.get('page'), 1)
    const requestedPageSize = parsePositiveInteger(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE)
    if (page === null || requestedPageSize === null) {
      return NextResponse.json({ error: 'page and pageSize must be positive integers' }, { status: 400 })
    }
    const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE)
    const offset = (page - 1) * pageSize

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw<LatestFlaggedRow[]>`
        SELECT * FROM (
          SELECT DISTINCT ON ("entityType", "entityId") *
          FROM "RiskAssessment"
          ORDER BY "entityType", "entityId", "createdAt" DESC
        ) latest
        WHERE "status" = 'flagged'
        ORDER BY "riskScore" DESC, "createdAt" DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM (
          SELECT DISTINCT ON ("entityType", "entityId") "status"
          FROM "RiskAssessment"
          ORDER BY "entityType", "entityId", "createdAt" DESC
        ) latest
        WHERE "status" = 'flagged'
      `,
    ])

    const total = Number(countRows[0]?.count ?? 0)

    return NextResponse.json({
      assessments: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/risk-assessments/flagged error')
    return NextResponse.json({ error: 'Failed to fetch flagged risk assessments' }, { status: 500 })
  }
}
