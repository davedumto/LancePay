import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { isSupportedAnchor, SUPPORTED_ANCHORS } from '@/lib/anchors'
import { initiateSep24Session } from '@/lib/sep24'

const SESSION_EXPIRY_MINUTES = parseInt(
  process.env.ANCHOR_SESSION_EXPIRY_MINUTES ?? '30'
)

// ── GET /api/anchor-sessions ────────────────────────────────────────────

/**
 * List all anchor sessions for the authenticated user.
 * Sessions include computed status (active, expired, or terminated).
 * IMPORTANT: jwtToken is NEVER returned in the response.
 */
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')

    if (!claims) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      )
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'Not Found', message: 'User not found' },
        { status: 404 }
      )
    }

    // Fetch sessions — NEVER return jwtToken
    const anchorSessions = await prisma.anchorSession.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        anchorId: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    // Annotate with computed status (no database column needed)
    const now = new Date()
    const sessionsWithStatus = anchorSessions.map((s) => ({
      id: s.id,
      anchorId: s.anchorId,
      computedStatus: s.expiresAt && s.expiresAt < now ? 'expired' : 'active',
      expiresAt: s.expiresAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    }))

    return NextResponse.json({ sessions: sessionsWithStatus }, { status: 200 })
  } catch (error) {
    console.error('GET /api/anchor-sessions error:', error instanceof Error ? error.message : 'Unknown error')

    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to fetch anchor sessions' },
      { status: 500 }
    )
  }
}

// ── POST /api/anchor-sessions ───────────────────────────────────────────

/**
 * Create or refresh a SEP-24 anchor session.
 * Initiates the interactive flow with the anchor and stores the session.
 * IMPORTANT: jwtToken is stored securely in the database but NEVER returned.
 */
export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')

    if (!claims) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      )
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'Not Found', message: 'User not found' },
        { status: 404 }
      )
    }

    // Parse and validate request body
    let body: { anchorId?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Bad Request', message: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const { anchorId } = body

    // Validate anchorId is present
    if (!anchorId) {
      return NextResponse.json(
        { error: 'Bad Request', message: 'anchorId is required' },
        { status: 400 }
      )
    }

    // Validate anchorId against supported list
    if (!isSupportedAnchor(anchorId)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          message: `Unsupported anchor: "${anchorId}". Supported anchors: ${SUPPORTED_ANCHORS.join(', ')}`,
        },
        { status: 400 }
      )
    }

    // Initiate SEP-24 interactive flow with the anchor
    let sep24Result
    try {
      sep24Result = await initiateSep24Session(anchorId, user.id)
    } catch (error) {
      console.error('SEP-24 initiation error:', error instanceof Error ? error.message : 'Unknown error')
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to initiate anchor session' },
        { status: 500 }
      )
    }

    // Compute expiry
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000)

    // Upsert — enforce unique userId + anchorId constraint
    // Do NOT error on repeat session starts — refresh instead
    const anchorSession = await prisma.anchorSession.upsert({
      where: {
        userId_anchorId: {
          userId: user.id,
          anchorId,
        },
      },
      create: {
        userId: user.id,
        anchorId,
        jwtToken: sep24Result.jwtToken, // stored but NEVER logged or returned
        expiresAt,
      },
      update: {
        jwtToken: sep24Result.jwtToken, // refresh token
        expiresAt, // reset expiry
        updatedAt: new Date(),
      },
      select: {
        id: true,
        anchorId: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        // NEVER select jwtToken in response
      },
    })

    // Return interactiveUrl for the client to redirect to
    // Return session metadata — NEVER return jwtToken
    return NextResponse.json(
      {
        id: anchorSession.id,
        anchorId: anchorSession.anchorId,
        interactiveUrl: sep24Result.interactiveUrl,
        expiresAt: anchorSession.expiresAt?.toISOString() ?? null,
        createdAt: anchorSession.createdAt.toISOString(),
        updatedAt: anchorSession.updatedAt.toISOString(),
      },
      { status: 201 }
    )
  } catch (error) {
    // NEVER log jwtToken even in error handling
    console.error(
      'POST /api/anchor-sessions error:',
      error instanceof Error ? error.message : 'Unknown error'
    )

    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to create anchor session' },
      { status: 500 }
    )
  }
}
