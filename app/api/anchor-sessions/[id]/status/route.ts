import { NextRequest, NextResponse } from 'next/server'

import { prisma } from '@/lib/db'

import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth'

// Status response type — NEVER include jwtToken
export interface AnchorSessionStatus {
  id: string
  status: 'active' | 'expired' | 'terminated'
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // 1. Authenticate the caller
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      )
    }

    const { id } = params

    // 2. Find the anchor session
    // SELECT only safe fields — explicitly exclude jwtToken
    const anchorSession = await prisma.anchorSession.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    // 3. Return 404 if session does not exist
    if (!anchorSession) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Anchor session not found' },
        { status: 404 }
      )
    }

    // 4. Ownership check — only session owner may view status
    if (anchorSession.userId !== session.user.id) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'You do not own this anchor session' },
        { status: 403 }
      )
    }

    // 5. Determine current status explicitly
    const now = new Date()

    // Check expired — explicit expired state, not stale-looking valid
    if (anchorSession.expiresAt && anchorSession.expiresAt < now) {
      return NextResponse.json({
        id: anchorSession.id,
        status: 'expired',
        expiresAt: anchorSession.expiresAt.toISOString(),
        createdAt: anchorSession.createdAt.toISOString(),
        updatedAt: anchorSession.updatedAt.toISOString(),
      }, { status: 200 })
    }

    // Session is active
    return NextResponse.json({
      id: anchorSession.id,
      status: 'active',
      expiresAt: anchorSession.expiresAt?.toISOString() ?? null,
      createdAt: anchorSession.createdAt.toISOString(),
      updatedAt: anchorSession.updatedAt.toISOString(),
    }, { status: 200 })
  } catch (error) {
    console.error('GET /api/anchor-sessions/[id]/status error:', error)
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to fetch session status' },
      { status: 500 }
    )
  }
}
