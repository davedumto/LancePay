import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../_lib/authz'
import { errorResponse } from '../_lib/errors'

const PREF_KEY = 'routesBLateFeePolicy'

const RATE_MIN = 0
const RATE_MAX = 0.5
const PERIOD_MIN = 1
const PERIOD_MAX = 365
const CAP_MIN = 0
const CAP_MAX = 1

interface LateFeePolicy {
  ratePerPeriod: number
  periodDays: number
  capFraction: number
}

const DEFAULT_POLICY: LateFeePolicy = {
  ratePerPeriod: 0.015,
  periodDays: 30,
  capFraction: 0.1,
}

function parsePolicyFromCustomMessage(raw?: string | null): LateFeePolicy {
  if (!raw) return DEFAULT_POLICY
  try {
    const parsed = JSON.parse(raw)
    const stored = parsed?.[PREF_KEY]
    if (!stored || typeof stored !== 'object') return DEFAULT_POLICY
    return { ...DEFAULT_POLICY, ...stored }
  } catch {
    return DEFAULT_POLICY
  }
}

function mergePolicyIntoCustomMessage(raw: string | null | undefined, policy: LateFeePolicy): string {
  let parsed: Record<string, unknown> = {}
  try {
    if (raw) parsed = JSON.parse(raw)
  } catch {
    // ignore
  }
  return JSON.stringify({ ...parsed, [PREF_KEY]: policy })
}

async function GETHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    const settings = await prisma.reminderSettings.findUnique({
      where: { userId: auth.userId },
      select: { id: true, customMessage: true },
    })

    const policy = parsePolicyFromCustomMessage(settings?.customMessage)

    return NextResponse.json({ policy })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to get late-fee policy', {}, 500)
  }
}

async function POSTHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('BAD_REQUEST', 'Invalid JSON body', {}, 400)
    }

    const b = body as Record<string, unknown>

    const ratePerPeriod = b?.ratePerPeriod
    const periodDays = b?.periodDays
    const capFraction = b?.capFraction

    if (
      typeof ratePerPeriod !== 'number' ||
      !Number.isFinite(ratePerPeriod) ||
      ratePerPeriod < RATE_MIN ||
      ratePerPeriod > RATE_MAX
    ) {
      return errorResponse('BAD_REQUEST', `ratePerPeriod must be a number between ${RATE_MIN} and ${RATE_MAX}`, {}, 400)
    }

    if (
      typeof periodDays !== 'number' ||
      !Number.isInteger(periodDays) ||
      periodDays < PERIOD_MIN ||
      periodDays > PERIOD_MAX
    ) {
      return errorResponse('BAD_REQUEST', `periodDays must be an integer between ${PERIOD_MIN} and ${PERIOD_MAX}`, {}, 400)
    }

    if (
      typeof capFraction !== 'number' ||
      !Number.isFinite(capFraction) ||
      capFraction < CAP_MIN ||
      capFraction > CAP_MAX
    ) {
      return errorResponse('BAD_REQUEST', `capFraction must be a number between ${CAP_MIN} and ${CAP_MAX}`, {}, 400)
    }

    const policy: LateFeePolicy = { ratePerPeriod, periodDays, capFraction }

    const existing = await prisma.reminderSettings.findUnique({
      where: { userId: auth.userId },
      select: { id: true, customMessage: true },
    })

    const newCustomMessage = mergePolicyIntoCustomMessage(existing?.customMessage, policy)

    if (existing) {
      await prisma.reminderSettings.update({
        where: { id: existing.id },
        data: { customMessage: newCustomMessage },
      })
    } else {
      await prisma.reminderSettings.create({
        data: { userId: auth.userId, customMessage: newCustomMessage },
      })
    }

    return NextResponse.json({ policy }, { status: 201 })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to save late-fee policy', {}, 500)
  }
}

export const GET = withRequestId(GETHandler)
export const POST = withRequestId(POSTHandler)
