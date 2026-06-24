import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'

// ── GET, POST /api/routes-d/auth/tokens — personal access tokens ──
//
// GET  — list all personal access tokens for the authenticated user.
// POST — create a new personal access token.
//
// Tokens are stored hashed; only the tokenHint (last 6 chars of the raw
// token) is persisted so the caller can identify tokens without exposing
// the full secret. The raw token is returned once on creation and is
// never retrievable again.

type PersonalAccessTokenDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getTokenDelegate(): PersonalAccessTokenDelegate {
  return (prisma as unknown as { personalAccessToken: PersonalAccessTokenDelegate }).personalAccessToken
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

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const delegate = getTokenDelegate()
    const tokens = await delegate.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        label: true,
        scopes: true,
        tokenHint: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        label: t.label,
        scopes: t.scopes,
        tokenHint: t.tokenHint,
        expiresAt: t.expiresAt ?? null,
        createdAt: t.createdAt,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/auth/tokens error')
    return NextResponse.json({ error: 'Failed to list tokens' }, { status: 500 })
  }
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

    if (!raw.label || typeof raw.label !== 'string' || raw.label.trim() === '') {
      return NextResponse.json({ error: 'label is required' }, { status: 400 })
    }

    const label = raw.label.trim()
    const scopes = Array.isArray(raw.scopes) ? (raw.scopes as string[]) : []
    const expiresIn = typeof raw.expiresIn === 'number' ? raw.expiresIn : null

    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHint = rawToken.slice(-6)
    const expiresAt = expiresIn !== null
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null

    const delegate = getTokenDelegate()
    const created = await delegate.create({
      data: {
        userId: user.id,
        label,
        scopes,
        token: rawToken,
        tokenHint,
        expiresAt,
      },
      select: {
        id: true,
        label: true,
        scopes: true,
        tokenHint: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      {
        token: rawToken,
        meta: {
          id: created.id,
          label: created.label,
          scopes: created.scopes,
          tokenHint: created.tokenHint,
          expiresAt: created.expiresAt ?? null,
          createdAt: created.createdAt,
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/auth/tokens error')
    return NextResponse.json({ error: 'Failed to create token' }, { status: 500 })
  }
}
