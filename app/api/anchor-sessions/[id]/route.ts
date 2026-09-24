import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // 1. Authenticate the caller
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
        { error: 'Unauthorized', message: 'User not found' },
        { status: 401 }
      )
    }

    const { id } = params

    // 2. Find the anchor session
    const anchorSession = await prisma.anchorSession.findUnique({
      where: { id },
    })

    // 3. Return 404 if session does not exist
    if (!anchorSession) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Anchor session not found' },
        { status: 404 }
      )
    }

    // 4. Return 404 if already expired naturally (expiresAt < now)
    if (anchorSession.expiresAt && anchorSession.expiresAt < new Date()) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Anchor session has already expired' },
        { status: 404 }
      )
    }

    // 5. Check ownership — only session owner may terminate
    if (anchorSession.userId !== user.id) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'You do not own this anchor session' },
        { status: 403 }
      )
    }

    // 6. Terminate the session by invalidating the JWT token
    //    This prevents stale clients from using the old token to resume
    const terminated = await prisma.anchorSession.update({
      where: { id },
      data: {
        jwtToken: null, // invalidate token — stale clients cannot resume
      },
    })

    return NextResponse.json(
      {
        message: 'Anchor session terminated successfully',
        id: terminated.id,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error('DELETE /api/anchor-sessions/[id] error:', error)
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to terminate session' },
      { status: 500 }
    )
  }
}
