import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes } from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const DEFAULT_PORTAL_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
export const MAX_PORTAL_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

export function hashClientPortalToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

export function deriveClientPortalTokenHint(rawToken: string): string {
  return rawToken.slice(0, 12)
}

function generateRawClientPortalToken(): string {
  return `cps_${randomBytes(24).toString('hex')}`
}

async function resolveClientId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

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

  return { error: null, status: 200 as const, user: { id: userId } }
}

function formatPortalSession(record: Record<string, any>) {
  const hashed = record.hashedToken ?? record.tokenHash ?? null
  return {
    id: record.id,
    userId: record.userId,
    clientId: record.clientId,
    hashedToken: hashed,
    tokenHash: hashed,
    tokenHint: record.tokenHint,
    lastSeenAt: record.lastSeenAt
      ? new Date(record.lastSeenAt).toISOString()
      : null,
    revokedAt: record.revokedAt
      ? new Date(record.revokedAt).toISOString()
      : null,
    expiresAt: record.expiresAt
      ? new Date(record.expiresAt).toISOString()
      : null,
    createdAt: record.createdAt
      ? new Date(record.createdAt).toISOString()
      : null,
  }
}

/**
 * GET /api/clients/[id]/portal-sessions
 * Lists portal sessions for the specified client owned by the authenticated freelancer.
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const clientId = await resolveClientId(context)
    if (!clientId) {
      return NextResponse.json(
        { error: 'Client ID is required' },
        { status: 400 },
      )
    }

    const rows = (await prisma.clientPortalSession.findMany({
      where: {
        userId: auth.user.id,
        clientId,
      },
      orderBy: { createdAt: 'desc' },
    })) as Array<Record<string, any>>

    return NextResponse.json({
      clientId,
      sessions: (rows ?? []).map(formatPortalSession),
      total: (rows ?? []).length,
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/clients/[id]/portal-sessions error')
    return NextResponse.json(
      { error: 'Failed to list client portal sessions' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/clients/[id]/portal-sessions
 * Issues a revocable `ClientPortalSession` token for a client:
 * - Returns the existing active session rather than creating a duplicate if one is already valid and not revoked.
 * - Generates a raw token, hashes it for storage (`hashedToken` / `tokenHash`), and derives `tokenHint` as a short display prefix (`<= 12` chars).
 * - Sets a bounded `expiresAt` and never logs or persists the raw token.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const clientId = await resolveClientId(context)
    if (!clientId) {
      return NextResponse.json(
        { error: 'Client ID is required' },
        { status: 400 },
      )
    }

    const body = await req.json().catch(() => ({}))
    const now = new Date()
    const nowMs = now.getTime()

    let expiresAt: Date
    if (body && typeof body === 'object' && body.expiresInSeconds !== undefined) {
      const ttlSeconds = Number(body.expiresInSeconds)
      if (
        !Number.isFinite(ttlSeconds) ||
        ttlSeconds <= 0 ||
        ttlSeconds > MAX_PORTAL_SESSION_TTL_SECONDS
      ) {
        return NextResponse.json(
          {
            error: `expiresInSeconds must be between 1 and ${MAX_PORTAL_SESSION_TTL_SECONDS} seconds (30 days)`,
            code: 'INVALID_PORTAL_SESSION_EXPIRY',
          },
          { status: 400 },
        )
      }
      expiresAt = new Date(nowMs + ttlSeconds * 1000)
    } else if (body && typeof body === 'object' && body.expiresAt) {
      const parsedDate = new Date(body.expiresAt)
      const diffSeconds = (parsedDate.getTime() - nowMs) / 1000
      if (
        Number.isNaN(parsedDate.getTime()) ||
        diffSeconds <= 0 ||
        diffSeconds > MAX_PORTAL_SESSION_TTL_SECONDS
      ) {
        return NextResponse.json(
          {
            error:
              'expiresAt must be in the future and at most 30 days from now',
            code: 'INVALID_PORTAL_SESSION_EXPIRY',
          },
          { status: 400 },
        )
      }
      expiresAt = parsedDate
    } else {
      expiresAt = new Date(nowMs + DEFAULT_PORTAL_SESSION_TTL_SECONDS * 1000)
    }

    // 1. Check for an existing active, non-revoked, non-expired session for (userId, clientId)
    let existingActive: Record<string, any> | null = null
    if (typeof prisma.clientPortalSession?.findFirst === 'function') {
      const candidate = await prisma.clientPortalSession.findFirst({
        where: {
          userId: auth.user.id,
          clientId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
      })
      if (
        candidate &&
        !candidate.revokedAt &&
        (!candidate.expiresAt ||
          new Date(candidate.expiresAt).getTime() > nowMs)
      ) {
        existingActive = candidate
      }
    } else if (typeof prisma.clientPortalSession?.findMany === 'function') {
      const candidates = ((await prisma.clientPortalSession.findMany({
        where: { userId: auth.user.id, clientId },
      })) ?? []) as Array<Record<string, any>>
      existingActive =
        candidates.find(
          (c) =>
            !c.revokedAt &&
            (!c.expiresAt || new Date(c.expiresAt).getTime() > nowMs),
        ) ?? null
    }

    if (existingActive) {
      return NextResponse.json(
        {
          reusedExisting: true,
          session: formatPortalSession(existingActive),
        },
        { status: 200 },
      )
    }

    // 2. Generate a new raw token, hash it for storage, and derive short tokenHint
    const rawToken = generateRawClientPortalToken()
    const hashedToken = hashClientPortalToken(rawToken)
    const tokenHint = deriveClientPortalTokenHint(rawToken)

    const created = await prisma.clientPortalSession.create({
      data: {
        userId: auth.user.id,
        clientId,
        hashedToken,
        tokenHint,
        expiresAt,
      },
    })

    // Log only non-sensitive metadata — NEVER log rawToken
    logger?.info?.(
      {
        portalSessionId: created.id,
        userId: auth.user.id,
        clientId,
        tokenHint,
        expiresAt: expiresAt.toISOString(),
      },
      'Issued client portal session token',
    )

    return NextResponse.json(
      {
        reusedExisting: false,
        token: rawToken,
        session: formatPortalSession(created),
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/clients/[id]/portal-sessions error')
    return NextResponse.json(
      { error: 'Failed to issue client portal session' },
      { status: 500 },
    )
  }
}
