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

export async function PATCH(request: NextRequest) {
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

    let body: {
      sendOnDueDate?: unknown
      sendDaysBefore?: unknown
      sendDaysAfter?: unknown
    }

    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const updateData: {
      onDueEnabled?: boolean
      beforeDueDays?: number[]
      afterDueDays?: number[]
    } = {}

    if (body.sendOnDueDate !== undefined) {
      if (typeof body.sendOnDueDate !== 'boolean') {
        return NextResponse.json({ error: 'sendOnDueDate must be a boolean' }, { status: 400 })
      }
      updateData.onDueEnabled = body.sendOnDueDate
    }

    if (body.sendDaysBefore !== undefined) {
      if (
        typeof body.sendDaysBefore !== 'number' ||
        !Number.isInteger(body.sendDaysBefore) ||
        body.sendDaysBefore < 0 ||
        body.sendDaysBefore > 30
      ) {
        return NextResponse.json(
          { error: 'sendDaysBefore must be an integer between 0 and 30' },
          { status: 400 }
        )
      }
      updateData.beforeDueDays = [body.sendDaysBefore]
    }

    if (body.sendDaysAfter !== undefined) {
      if (
        typeof body.sendDaysAfter !== 'number' ||
        !Number.isInteger(body.sendDaysAfter) ||
        body.sendDaysAfter < 0 ||
        body.sendDaysAfter > 30
      ) {
        return NextResponse.json(
          { error: 'sendDaysAfter must be an integer between 0 and 30' },
          { status: 400 }
        )
      }
      updateData.afterDueDays = [body.sendDaysAfter]
    }

    const settings = await prisma.reminderSettings.upsert({
      where: { userId: user.id },
      update: updateData,
      create: {
        userId: user.id,
        ...updateData,
      },
      select: {
        id: true,
        onDueEnabled: true,
        beforeDueDays: true,
        afterDueDays: true,
      },
    })

    return NextResponse.json(
      {
        settings: {
          id: settings.id,
          sendOnDueDate: settings.onDueEnabled,
          sendDaysBefore: settings.beforeDueDays[0] ?? null,
          sendDaysAfter: settings.afterDueDays[0] ?? null,
        },
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Routes B reminder-settings PATCH error')
    return NextResponse.json({ error: 'Failed to update reminder settings' }, { status: 500 })
  }
}
