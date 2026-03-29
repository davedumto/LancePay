import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const settings = await prisma.reminderSettings.findUnique({
      where: { userId: user.id },
      select: {
        id: true,
        enabled: true,
        beforeDueDays: true,
        onDueEnabled: true,
        afterDueDays: true,
        customMessage: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ settings: settings ?? null })
  } catch (error) {
    logger.error({ err: error }, 'Routes B reminder-settings GET error')
    return NextResponse.json({ error: 'Failed to get reminder settings' }, { status: 500 })
  }
}
