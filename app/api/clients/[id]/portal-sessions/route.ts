import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateToken, hashToken } from '@/lib/crypto'
import { logger } from '@/lib/logger'

const DEFAULT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7 // 7 days
const MAX_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 90 // 90 days

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function parseExpiresInSeconds(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error('expiresInSeconds must be a positive number')
  }
  if (raw > MAX_EXPIRES_IN_SECONDS) {
    throw new Error(`expiresInSeconds must be ${MAX_EXPIRES_IN_SECONDS} or fewer`)
  }
  return Math.floor(raw)
}

async function findOwnedClient(clientId: string, userId: string) {
  const client = await prisma.user.findFirst({
    where: { id: clientId },
    select: { id: true, email: true },
  })
  if (!client) return null

  const hasInvoiceRelationship = await prisma.invoice.findFirst({
    where: { clientId, userId },
    select: { id: true },
  })
  if (!hasInvoiceRelationship) return null

  return client
}

/**
 * GET /api/clients/[id]/portal-sessions
 * List all portal sessions for a client.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: clientId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!clientId || !clientId.trim()) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 })
    }

    const client = await findOwnedClient(clientId, user.id)
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const sessions = await prisma.clientPortalSession.findMany({
      where: { userId: user.id, clientId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        tokenHint: true,
        lastSeenAt: true,
        revokedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      sessions: sessions.map((session) => ({
        ...session,
        lastSeenAt: session.lastSeenAt ? session.lastSeenAt.toISOString() : null,
        revokedAt: session.revokedAt ? session.revokedAt.toISOString() : null,
        expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
        createdAt: session.createdAt.toISOString(),
        status: session.revokedAt
          ? 'revoked'
          : session.expiresAt && session.expiresAt.getTime() <= Date.now()
            ? 'expired'
            : 'active',
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/clients/[id]/portal-sessions error')
    return NextResponse.json({ error: 'Failed to fetch portal sessions' }, { status: 500 })
  }
}

/**
 * POST /api/clients/[id]/portal-sessions
 * Issue a new portal session for a client, or return an existing active session.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: clientId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!clientId || !clientId.trim()) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 })
    }

    const client = await findOwnedClient(clientId, user.id)
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { expiresInSeconds } = payload

    let expiresAt: Date | null
    try {
      const parsedExpires = parseExpiresInSeconds(expiresInSeconds)
      expiresAt = parsedExpires ? new Date(Date.now() + parsedExpires * 1000) : new Date(Date.now() + DEFAULT_EXPIRES_IN_SECONDS * 1000)
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 })
    }

    const now = new Date()

    const existingActiveSession = await prisma.clientPortalSession.findFirst({
      where: {
        userId: user.id,
        clientId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: {
        id: true,
        tokenHint: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    if (existingActiveSession) {
      return NextResponse.json({
        session: {
          id: existingActiveSession.id,
          tokenHint: existingActiveSession.tokenHint,
          expiresAt: existingActiveSession.expiresAt ? existingActiveSession.expiresAt.toISOString() : null,
          createdAt: existingActiveSession.createdAt.toISOString(),
        },
      })
    }

    const token = generateToken()
    const hashedToken = hashToken(token)
    const tokenHint = token.slice(-8)

    const session = await prisma.clientPortalSession.create({
      data: {
        userId: user.id,
        clientId,
        hashedToken,
        tokenHint,
        expiresAt,
      },
      select: {
        id: true,
        tokenHint: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      {
        session: {
          id: session.id,
          token,
          tokenHint: session.tokenHint,
          expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
          createdAt: session.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/clients/[id]/portal-sessions error')
    return NextResponse.json({ error: 'Failed to issue portal session' }, { status: 500 })
  }
}
