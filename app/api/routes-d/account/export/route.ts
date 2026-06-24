import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── POST /api/routes-d/account/export — request a data export ──
//
// Queues an asynchronous export of the authenticated user's data.
// Only one pending export is allowed at a time; re-requesting while
// one is already queued returns 409 so the client can surface the
// existing request instead of silently creating duplicates.
//
// Body (all fields optional):
//   format      — "json" | "csv"  (default: "json")
//   includeData — string[]        (scopes to export; default: all)

const VALID_FORMATS = ['json', 'csv'] as const
type ExportFormat = typeof VALID_FORMATS[number]

const VALID_DATA_SCOPES = [
  'invoices',
  'transactions',
  'contacts',
  'settings',
  'bank_accounts',
] as const
type DataScope = typeof VALID_DATA_SCOPES[number]

type DataExportDelegate = {
  findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getExportDelegate(): DataExportDelegate {
  return (prisma as unknown as { dataExport: DataExportDelegate }).dataExport
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const raw = (body ?? {}) as Record<string, unknown>

    // ── Validate format ─────────────────────────────────────────────────────
    const formatParam = raw.format
    let format: ExportFormat = 'json'

    if (formatParam !== undefined) {
      if (!VALID_FORMATS.includes(formatParam as ExportFormat)) {
        return NextResponse.json(
          { error: `format must be one of: ${VALID_FORMATS.join(', ')}` },
          { status: 400 },
        )
      }
      format = formatParam as ExportFormat
    }

    // ── Validate includeData ────────────────────────────────────────────────
    let includeData: DataScope[] = [...VALID_DATA_SCOPES]

    if (raw.includeData !== undefined) {
      if (!Array.isArray(raw.includeData) || raw.includeData.length === 0) {
        return NextResponse.json(
          { error: 'includeData must be a non-empty array' },
          { status: 400 },
        )
      }
      const invalid = (raw.includeData as unknown[]).filter(
        (s) => !VALID_DATA_SCOPES.includes(s as DataScope),
      )
      if (invalid.length > 0) {
        return NextResponse.json(
          {
            error: `Invalid data scope(s): ${invalid.join(', ')}. Must be one of: ${VALID_DATA_SCOPES.join(', ')}`,
          },
          { status: 400 },
        )
      }
      includeData = raw.includeData as DataScope[]
    }

    const delegate = getExportDelegate()

    // ── Idempotency guard ───────────────────────────────────────────────────
    const existing = await delegate.findFirst({
      where: { userId: user.id, status: 'pending' },
      select: { id: true, format: true, createdAt: true },
    })

    if (existing) {
      return NextResponse.json(
        {
          id: existing.id,
          status: 'pending',
          format: existing.format,
          createdAt: existing.createdAt,
          message: 'A data export is already pending. Wait for it to complete before requesting a new one.',
        },
        { status: 409 },
      )
    }

    // ── Create the export request ───────────────────────────────────────────
    const exportRequest = await delegate.create({
      data: {
        userId: user.id,
        status: 'pending',
        format,
        includeData,
      },
      select: {
        id: true,
        status: true,
        format: true,
        includeData: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      {
        id: exportRequest.id,
        status: exportRequest.status,
        format: exportRequest.format,
        includeData: exportRequest.includeData,
        createdAt: exportRequest.createdAt,
        message: 'Your data export has been queued. You will be notified when it is ready.',
      },
      { status: 202 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/account/export error')
    return NextResponse.json({ error: 'Failed to request data export' }, { status: 500 })
  }
}
