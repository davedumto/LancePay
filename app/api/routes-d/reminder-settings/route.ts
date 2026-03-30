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

// ── PATCH /api/routes-d/reminder-settings — update invoice reminder settings ──

export async function PATCH(request: NextRequest) {
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

    const body = await request.json()
    const { sendOnDueDate, sendDaysBefore, sendDaysAfter } = body

    // Validation
    if (sendDaysBefore !== undefined) {
      if (typeof sendDaysBefore !== 'number' || sendDaysBefore < 0 || sendDaysBefore > 30) {
        return NextResponse.json({ error: 'sendDaysBefore must be between 0 and 30' }, { status: 400 })
      }
    }
    if (sendDaysAfter !== undefined) {
      if (typeof sendDaysAfter !== 'number' || sendDaysAfter < 0 || sendDaysAfter > 90) {
        return NextResponse.json({ error: 'sendDaysAfter must be between 0 and 90' }, { status: 400 })
      }
    }

    // Mapping to schema
    const updateData: any = {}
    if (sendOnDueDate !== undefined) updateData.onDueEnabled = sendOnDueDate
    if (sendDaysBefore !== undefined) {
      updateData.beforeDueDays = sendDaysBefore === 0 ? [] : [sendDaysBefore]
    }
    if (sendDaysAfter !== undefined) {
      updateData.afterDueDays = sendDaysAfter === 0 ? [] : [sendDaysAfter]
    }

    const settings = await prisma.reminderSettings.upsert({
      where: { userId: user.id },
      update: updateData,
      create: {
        userId: user.id,
        onDueEnabled: sendOnDueDate ?? true,
        beforeDueDays: sendDaysBefore !== undefined ? (sendDaysBefore === 0 ? [] : [sendDaysBefore]) : [3, 1],
        afterDueDays: sendDaysAfter !== undefined ? (sendDaysAfter === 0 ? [] : [sendDaysAfter]) : [1, 3, 7],
      },
    })

    return NextResponse.json({
      settings: {
        sendOnDueDate: settings.onDueEnabled,
        sendDaysBefore: settings.beforeDueDays[0] ?? 0,
        sendDaysAfter: settings.afterDueDays[0] ?? 0,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'ReminderSettings PATCH error')
    return NextResponse.json({ error: 'Failed to update reminder settings' }, { status: 500 })
  }
}

