import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/reminder-settings — get invoice reminder settings ──

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const settings = await prisma.reminderSettings.findUnique({
      where: { userId: user.id },
    })

    if (!settings) {
      return NextResponse.json({ settings: null })
    }

    return NextResponse.json({
      settings: {
        id: settings.id,
        enabled: settings.enabled,
        beforeDueDays: settings.beforeDueDays,
        onDueEnabled: settings.onDueEnabled,
        afterDueDays: settings.afterDueDays,
        customMessage: settings.customMessage ?? null,
        createdAt: settings.createdAt,
        updatedAt: settings.updatedAt,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'ReminderSettings GET error')
    return NextResponse.json({ error: 'Failed to get reminder settings' }, { status: 500 })
  }
}
