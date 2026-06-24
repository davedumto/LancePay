import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type UserSessionDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getSessionDelegate(): UserSessionDelegate {
  return (prisma as unknown as { userSession: UserSessionDelegate }).userSession
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const delegate = getSessionDelegate()

    const session = await delegate.findUnique({
      where: { id },
      select: { id: true, userId: true, revokedAt: true },
    })

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    if ((session as { userId: string }).userId !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    if ((session as { revokedAt: unknown }).revokedAt !== null) {
      return NextResponse.json({ error: 'Session already revoked' }, { status: 409 })
    }

    await delegate.update({
      where: { id },
      data: { revokedAt: new Date() },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-d/auth/sessions/[id] error')
    return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 })
  }
}
