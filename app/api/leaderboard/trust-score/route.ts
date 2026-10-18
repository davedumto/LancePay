import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

export const DEFAULT_LEADERBOARD_LIMIT = 20
export const MAX_LEADERBOARD_LIMIT = 100

export type HandlePrivacyMode = 'anonymous' | 'initials' | 'handle'

export interface LeaderboardEntry {
  rank: number
  participantId: string
  displayHandle: string
  privacyMode: HandlePrivacyMode
  avatarUrl: string | null
  score: number
  totalVolumeUsdc: number
  successfulInvoices: number
  badgeCount: number
  accountCreatedAt: string
}

export function formatLeaderboardHandle(user: {
  id: string
  name?: string | null
  displayHandle?: string | null
  privacyPreference?: string | null
  handlePrivacy?: string | null
  anonymizeHandle?: boolean | null
}): { displayHandle: string; privacyMode: HandlePrivacyMode; participantId: string } {
  const hashSuffix = crypto
    .createHash('sha256')
    .update(String(user.id))
    .digest('hex')
    .slice(0, 6)
    .toUpperCase()
  const participantId = `lp_${hashSuffix.toLowerCase()}`

  const modeRaw = (
    user.privacyPreference ??
    user.handlePrivacy ??
    (user.anonymizeHandle ? 'anonymous' : 'handle')
  )
    .toString()
    .trim()
    .toLowerCase()

  if (modeRaw === 'anonymous' || user.anonymizeHandle === true) {
    return {
      displayHandle: `Freelancer #${hashSuffix}`,
      privacyMode: 'anonymous',
      participantId,
    }
  }

  const rawName = (user.displayHandle ?? user.name ?? '').trim()
  // Never use an email-like string as a display handle
  if (!rawName || rawName.includes('@')) {
    return {
      displayHandle: `Freelancer #${hashSuffix}`,
      privacyMode: 'anonymous',
      participantId,
    }
  }

  const parts = rawName.split(/\s+/).filter(Boolean)

  if (modeRaw === 'initials') {
    const initials = parts.map((p) => `${p[0].toUpperCase()}.`).join(' ')
    return {
      displayHandle: initials,
      privacyMode: 'initials',
      participantId,
    }
  }

  // Default 'handle' mode: First name + last initial (e.g., "Ada L.") or single handle
  const formatted =
    parts.length > 1
      ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
      : parts[0]

  return {
    displayHandle: formatted,
    privacyMode: 'handle',
    participantId,
  }
}

export function encodeLeaderboardCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

export function decodeLeaderboardCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { offset?: unknown }
    if (
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return parsed.offset
    }
    return null
  } catch {
    return null
  }
}

function isOptedInToLeaderboard(user: Record<string, any> | null | undefined): boolean {
  if (!user) return false
  if (user.leaderboardOptIn === false) return false
  if (user.publicVisibility === false) return false
  return user.leaderboardOptIn === true || user.publicVisibility === true
}

/**
 * GET /api/leaderboard/trust-score
 * Ranks users by trust score for the public leaderboard:
 * - Includes ONLY users who have opted in to public leaderboard visibility (`leaderboardOptIn: true` / `publicVisibility: true`).
 * - Anonymizes or formats display handles according to each user's privacy preference and never leaks email or PII.
 * - Supports pagination (`limit`, `cursor`, `offset`) and deterministic tie-breaking by completed volume,
 *   successful invoices, and account age.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)

    const rawLimit = searchParams.get('limit')
    const limit =
      rawLimit !== null ? parseInt(rawLimit, 10) : DEFAULT_LEADERBOARD_LIMIT
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LEADERBOARD_LIMIT
    ) {
      return NextResponse.json(
        {
          error: `limit must be an integer between 1 and ${MAX_LEADERBOARD_LIMIT}`,
          code: 'INVALID_LIMIT',
        },
        { status: 400 },
      )
    }

    const cursorParam = searchParams.get('cursor')?.trim() || null
    const rawOffset = searchParams.get('offset')

    let offset = 0
    if (cursorParam) {
      const decoded = decodeLeaderboardCursor(cursorParam)
      if (decoded === null) {
        return NextResponse.json(
          { error: 'Invalid pagination cursor', code: 'INVALID_CURSOR' },
          { status: 400 },
        )
      }
      offset = decoded
    } else if (rawOffset !== null) {
      const parsedOffset = parseInt(rawOffset, 10)
      if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
        return NextResponse.json(
          { error: 'offset must be a non-negative integer', code: 'INVALID_OFFSET' },
          { status: 400 },
        )
      }
      offset = parsedOffset
    }

    const rows = (await prisma.userTrustScore.findMany({
      where: {
        user: {
          publicVisibility: true,
        },
      },
      include: {
        user: {
          include: {
            userBadges: true,
          },
        },
      },
    })) as Record<string, any>[]

    // Strictly filter opted-in users
    const optedInRows = (rows ?? []).filter((r) =>
      isOptedInToLeaderboard(r.user),
    )

    // Sort deterministically:
    // 1. score DESC
    // 2. totalVolumeUsdc DESC
    // 3. successfulInvoices DESC
    // 4. user.createdAt ASC (older account ranks higher)
    // 5. userId ASC
    optedInRows.sort((a, b) => {
      const scoreDiff = Number(b.score ?? 0) - Number(a.score ?? 0)
      if (scoreDiff !== 0) return scoreDiff

      const volDiff =
        Number(b.totalVolumeUsdc ?? 0) - Number(a.totalVolumeUsdc ?? 0)
      if (volDiff !== 0) return volDiff

      const invDiff =
        Number(b.successfulInvoices ?? 0) - Number(a.successfulInvoices ?? 0)
      if (invDiff !== 0) return invDiff

      const aCreated = a.user?.createdAt
        ? new Date(a.user.createdAt).getTime()
        : 0
      const bCreated = b.user?.createdAt
        ? new Date(b.user.createdAt).getTime()
        : 0
      if (aCreated !== bCreated) return aCreated - bCreated

      return String(a.userId ?? '').localeCompare(String(b.userId ?? ''))
    })

    const rankedEntries: LeaderboardEntry[] = optedInRows.map((row, idx) => {
      const u = row.user ?? {}
      const { displayHandle, privacyMode, participantId } =
        formatLeaderboardHandle({
          id: String(row.userId ?? u.id ?? idx),
          name: u.name,
          displayHandle: u.displayHandle,
          privacyPreference: u.privacyPreference,
          handlePrivacy: u.handlePrivacy,
          anonymizeHandle: u.anonymizeHandle,
        })

      return {
        rank: idx + 1,
        participantId,
        displayHandle,
        privacyMode,
        avatarUrl: privacyMode === 'anonymous' ? null : (u.avatarUrl ?? null),
        score: Number(row.score ?? 0),
        totalVolumeUsdc: Number(row.totalVolumeUsdc ?? 0),
        successfulInvoices: Number(row.successfulInvoices ?? 0),
        badgeCount: Array.isArray(u.userBadges) ? u.userBadges.length : 0,
        accountCreatedAt: u.createdAt
          ? new Date(u.createdAt).toISOString()
          : new Date(0).toISOString(),
      }
    })

    const pageSlice = rankedEntries.slice(offset, offset + limit)
    const nextOffset = offset + pageSlice.length
    const hasMore = nextOffset < rankedEntries.length
    const nextCursor = hasMore ? encodeLeaderboardCursor(nextOffset) : null

    return NextResponse.json(
      {
        leaderboard: pageSlice,
        pagination: {
          totalOptedIn: rankedEntries.length,
          limit,
          offset,
          nextCursor,
          hasMore,
        },
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
        },
      },
    )
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/leaderboard/trust-score error')
    return NextResponse.json(
      { error: 'Failed to load trust score leaderboard' },
      { status: 500 },
    )
  }
}
