import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
export const VALID_RUN_STATUSES = [
  'success',
  'failed',
  'running',
  'completed',
  'pending',
] as const

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveAutomationId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

function parsePage(raw: string | null): number {
  if (!raw) return DEFAULT_PAGE
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_PAGE
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

export function computeRunDurationMs(
  startedAt: unknown,
  finishedAt: unknown,
): number | null {
  if (!startedAt || !finishedAt) return null
  const startMs = new Date(startedAt as string | number | Date).getTime()
  const endMs = new Date(finishedAt as string | number | Date).getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
  return Math.max(0, endMs - startMs)
}

function serializeAutomationRun(run: Record<string, any>) {
  const durationMs = computeRunDurationMs(run.startedAt, run.finishedAt)
  return {
    id: run.id,
    automationId: run.automationId,
    status: run.status,
    message: run.message ?? null,
    startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    durationMs,
    duration: durationMs,
  }
}

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

/**
 * GET /api/automations/[id]/runs
 * Lists `AutomationRun` execution history for an automation:
 * - Restricts visibility strictly to the automation owner (`403`).
 * - Supports pagination (`page`, `limit`) and filtering by `status`.
 * - Includes `message` and the computed duration (`durationMs`) from `startedAt` to `finishedAt`
 *   for completed runs.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const automationId = await resolveAutomationId(context)
    if (!automationId) {
      return NextResponse.json(
        { error: 'Automation ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const automation =
      typeof prisma.automation?.findUnique === 'function'
        ? await prisma.automation.findUnique({ where: { id: automationId } })
        : await prisma.automation.findFirst({ where: { id: automationId } })

    if (!automation) {
      return NextResponse.json(
        { error: 'Automation not found' },
        { status: 404 },
      )
    }

    if (automation.userId !== user.id) {
      return NextResponse.json(
        {
          error: 'Forbidden: only the automation owner can view run history',
          code: 'FORBIDDEN_AUTOMATION_OWNER',
        },
        { status: 403 },
      )
    }

    const { searchParams } = new URL(request.url)
    const rawStatus = searchParams.get('status')?.trim().toLowerCase() ?? ''
    if (
      rawStatus &&
      !(VALID_RUN_STATUSES as readonly string[]).includes(rawStatus)
    ) {
      return NextResponse.json(
        {
          error: `status must be one of: ${VALID_RUN_STATUSES.join(', ')}`,
          code: 'INVALID_RUN_STATUS',
        },
        { status: 400 },
      )
    }

    const page = parsePage(searchParams.get('page'))
    const limit = parseLimit(searchParams.get('limit'))
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {
      automationId,
      ...(rawStatus ? { status: rawStatus } : {}),
    }

    const rawRuns = ((await prisma.automationRun.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip,
      take: limit,
    })) ?? []) as Array<Record<string, any>>

    const filteredRuns = rawStatus
      ? rawRuns.filter(
          (r) => String(r.status ?? '').toLowerCase() === rawStatus,
        )
      : rawRuns

    const total =
      typeof prisma.automationRun?.count === 'function'
        ? ((await prisma.automationRun.count({ where })) ??
          filteredRuns.length)
        : filteredRuns.length

    return NextResponse.json({
      automationId,
      runs: filteredRuns.map(serializeAutomationRun),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/automations/[id]/runs error')
    return NextResponse.json(
      { error: 'Failed to fetch automation runs' },
      { status: 500 },
    )
  }
}
