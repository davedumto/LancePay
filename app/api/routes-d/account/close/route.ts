import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_REASON_LENGTH = 500

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, status: true },
  })
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (user.status === 'closed') {
      return NextResponse.json({ error: 'Account is already closed' }, { status: 409 })
    }

    let body: { reason?: unknown }
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const rawReason = body?.reason
    if (rawReason !== undefined && rawReason !== null && typeof rawReason !== 'string') {
      return NextResponse.json({ error: 'reason must be a string' }, { status: 422 })
    }

    const reason = typeof rawReason === 'string' ? rawReason.trim() : null

    if (reason !== null && reason.length > MAX_REASON_LENGTH) {
      return NextResponse.json(
        { error: `reason must be at most ${MAX_REASON_LENGTH} characters` },
        { status: 422 },
      )
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'closed' },
    })

    logger.info({ userId: user.id, reason }, 'Account closed')

    return NextResponse.json(
      {
        message: 'Account closed successfully',
        reason: reason ?? null,
        closedAt: new Date().toISOString(),
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /account/close error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
