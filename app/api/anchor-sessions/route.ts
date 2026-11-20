import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { isSupportedAnchor, SUPPORTED_ANCHORS } from '@/lib/anchors'
import { initiateSep24Session, SEP24_DIRECTIONS, type Sep24Direction } from '@/lib/sep24'

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
    let body: {
      anchorId?: string
      direction?: string
      assetCode?: string
      account?: string
      amount?: string | number
      memo?: string
    }
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

    // Validate direction when provided; these sessions are cash-out flows,
    // so 'withdraw' is the default. 'deposit' is only for on-ramp sessions.
    let direction: Sep24Direction = 'withdraw'
    if (body.direction !== undefined) {
      if (
        typeof body.direction !== 'string' ||
        !(SEP24_DIRECTIONS as readonly string[]).includes(body.direction)
      ) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            message: `Invalid direction: "${body.direction}". Supported directions: ${SEP24_DIRECTIONS.join(', ')}`,
          },
          { status: 400 }
        )
      }
      direction = body.direction as Sep24Direction
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
      sep24Result = await initiateSep24Session(anchorId, {
        direction,
        assetCode: body.assetCode,
        // The user's id is the anchor-side account identifier unless the
        // client supplies an explicit account.
        account: body.account ?? user.id,
        amount: body.amount,
        memo: body.memo,
      })
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
      },
      select: {
        id: true,
        anchorId: true,
        expiresAt: true,
        createdAt: true,
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
