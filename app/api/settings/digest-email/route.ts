import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const ALLOWED_DIGEST_FREQUENCIES = new Set([
  'daily',
  'weekly',
  'monthly',
] as const)

export type DigestFrequency = 'daily' | 'weekly' | 'monthly'

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  let userId = claims.userId
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
  }

  return {
    error: null,
    status: 200 as const,
    user: { id: userId },
  }
}

function formatDigestSettingsResponse(record: {
  id?: string | null
  userId: string
  enabled: boolean
  frequency: string
  lastSentAt?: Date | string | null
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}) {
  const lastSentAtIso = record.lastSentAt
    ? new Date(record.lastSentAt).toISOString()
    : null

  return {
    settings: {
      id: record.id ?? null,
      userId: record.userId,
      enabled: Boolean(record.enabled),
      frequency: record.frequency as DigestFrequency,
      lastSentAt: lastSentAtIso,
      createdAt: record.createdAt
        ? new Date(record.createdAt).toISOString()
        : null,
      updatedAt: record.updatedAt
        ? new Date(record.updatedAt).toISOString()
        : null,
    },
    lastSentAt: lastSentAtIso,
  }
}

/**
 * GET /api/settings/digest-email
 * Reads periodic digest email preferences for the authenticated user,
 * including `lastSentAt` so the user can see when their last digest went out.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const existing = await prisma.digestEmailSettings.findUnique({
      where: { userId: auth.user.id },
    })

    const record = existing ?? {
      userId: auth.user.id,
      enabled: true,
      frequency: 'weekly',
      lastSentAt: null,
    }

    return NextResponse.json(formatDigestSettingsResponse(record))
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/settings/digest-email error')
    return NextResponse.json(
      { error: 'Failed to fetch digest email settings' },
      { status: 500 },
    )
  }
}

/**
 * PATCH /api/settings/digest-email
 * Updates periodic digest email preferences:
 * - Upserts on first PATCH since the row is one-per-user.
 * - Validates `frequency` is one of `daily`, `weekly`, or `monthly`.
 * - Returns `lastSentAt` so the user can see when their last digest actually went out.
 */
export async function PATCH(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    const hasEnabled = 'enabled' in body
    const hasFrequency = 'frequency' in body

    if (!hasEnabled && !hasFrequency) {
      return NextResponse.json(
        {
          error: 'At least one of enabled or frequency must be provided',
          code: 'EMPTY_UPDATE',
        },
        { status: 400 },
      )
    }

    let enabled: boolean | undefined
    if (hasEnabled) {
      if (typeof body.enabled !== 'boolean') {
        return NextResponse.json(
          {
            error: 'enabled must be a boolean',
            code: 'INVALID_ENABLED',
          },
          { status: 400 },
        )
      }
      enabled = body.enabled
    }

    let frequency: DigestFrequency | undefined
    if (hasFrequency) {
      if (typeof body.frequency !== 'string') {
        return NextResponse.json(
          {
            error: 'frequency must be one of: daily, weekly, monthly',
            code: 'INVALID_DIGEST_FREQUENCY',
          },
          { status: 400 },
        )
      }
      const normalized = body.frequency.trim().toLowerCase()
      if (!ALLOWED_DIGEST_FREQUENCIES.has(normalized as DigestFrequency)) {
        return NextResponse.json(
          {
            error: 'frequency must be one of: daily, weekly, monthly',
            code: 'INVALID_DIGEST_FREQUENCY',
          },
          { status: 400 },
        )
      }
      frequency = normalized as DigestFrequency
    }

    const updateData: Record<string, unknown> = {}
    if (enabled !== undefined) {
      updateData.enabled = enabled
    }
    if (frequency !== undefined) {
      updateData.frequency = frequency
    }

    const upserted = await prisma.digestEmailSettings.upsert({
      where: { userId: auth.user.id },
      update: updateData,
      create: {
        userId: auth.user.id,
        enabled: enabled ?? true,
        frequency: frequency ?? 'weekly',
      },
    })

    return NextResponse.json(formatDigestSettingsResponse(upserted))
  } catch (err) {
    logger?.error?.({ err }, 'PATCH /api/settings/digest-email error')
    return NextResponse.json(
      { error: 'Failed to update digest email settings' },
      { status: 500 },
    )
  }
}
