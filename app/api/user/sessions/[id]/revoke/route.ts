import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const session = await prisma.userSession.findUnique({ where: { id } })
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    if (session.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (session.revokedAt) {
      return NextResponse.json({ error: 'Session is already revoked' }, { status: 400 })
    }

    const updated = await prisma.userSession.update({
      where: { id },
      data: { revokedAt: new Date() },
    })

    return NextResponse.json({ success: true, session: updated })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/user/sessions/[id]/revoke error')
    return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 })
  }
}
