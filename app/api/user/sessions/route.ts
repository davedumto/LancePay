import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedSession(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims?.sessionId) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  if (!user) return null

  const userAgent = request.headers.get('user-agent')
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
  const session = await prisma.userSession.upsert({
    where: { providerSessionId: claims.sessionId },
    create: {
      providerSessionId: claims.sessionId,
      userId: user.id,
      tokenHint: claims.sessionId.slice(-12),
      userAgent,
      ipAddress,
    },
    update: { lastSeenAt: new Date(), userAgent, ipAddress },
    select: { id: true, userId: true, providerSessionId: true },
  })

  if (session.userId !== user.id) return null
  return { user, session }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedSession(request)
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const sessions = await prisma.userSession.findMany({
      where: { userId: auth.user.id },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        deviceLabel: true,
        userAgent: true,
        ipAddress: true,
        tokenHint: true,
        issuedAt: true,
        lastSeenAt: true,
        revokedAt: true,
        providerSessionId: true,
      },
    })

    return NextResponse.json({
      sessions: sessions.map(({ providerSessionId, revokedAt, ...session }) => ({
        ...session,
        revokedAt,
        isActive: revokedAt === null,
        isCurrent: providerSessionId === auth.session.providerSessionId,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/user/sessions error')
    return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 })
  }
}