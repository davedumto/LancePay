import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = authToken ? await verifyAuthToken(authToken) : null
    if (!claims?.sessionId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const session = await prisma.userSession.upsert({
      where: { providerSessionId: claims.sessionId },
      create: {
        providerSessionId: claims.sessionId,
        userId: user.id,
        tokenHint: claims.sessionId.slice(-12),
        userAgent: request.headers.get('user-agent'),
        ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
      },
      update: { lastSeenAt: new Date() },
      select: { userId: true },
    })
    if (session.userId !== user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const result = await prisma.userSession.updateMany({
      where: {
        userId: user.id,
        OR: [
          { providerSessionId: { not: claims.sessionId } },
          { providerSessionId: null },
        ],
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    })

    return NextResponse.json({ revokedCount: result.count })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/user/sessions/revoke-all-others error')
    return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 })
  }
}