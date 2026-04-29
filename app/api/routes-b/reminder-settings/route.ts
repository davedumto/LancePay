import { withRequestId } from '../_lib/with-request-id'
import { withBodyLimit } from '../_lib/with-body-limit'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

import {
  DEFAULT_REMINDER_SETTINGS,
  reminderSettingsPatchSchema,
  type ReminderSettingsPatchPayload,
} from './schema'

import { hasTableColumn } from '../_lib/table-columns'

/* ---------------- utils ---------------- */

function formatFieldErrors(error: {
  issues: Array<{ path: Array<string | number>; message: string }>
}) {
  return error.issues.reduce<Record<string, string>>((fields, issue) => {
    const key = typeof issue.path[0] === 'string' ? issue.path[0] : 'body'
    if (!fields[key]) fields[key] = issue.message
    return fields
  }, {})
}

function normalizeReminderPayload(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input
  }

  const body = { ...(input as Record<string, unknown>) }

  if (
    !Object.prototype.hasOwnProperty.call(body, 'firstReminderDays') &&
    body.sendDaysBefore !== undefined
  ) {
    body.firstReminderDays = body.sendDaysBefore
  }

  if (
    !Object.prototype.hasOwnProperty.call(body, 'secondReminderDays') &&
    body.sendDaysAfter !== undefined
  ) {
    body.secondReminderDays = body.sendDaysAfter
  }

  return body
}

/* ---------------- helpers ---------------- */

async function persistReminderChannel(
  userId: string,
  payload: ReminderSettingsPatchPayload
) {
  if (!Object.prototype.hasOwnProperty.call(payload, 'channel')) {
    return undefined
  }

  const supported = await hasTableColumn('ReminderSettings', 'channel')
  if (!supported) return undefined

  await prisma.$executeRaw`
    UPDATE "ReminderSettings"
    SET "channel" = ${payload.channel},
        "updatedAt" = NOW()
    WHERE "userId" = ${userId}
  `

  return payload.channel
}

/* ---------------- GET ---------------- */

async function GETHandler(request: NextRequest) {
  try {
    const authToken = request.headers
      .get('authorization')
      ?.replace('Bearer ', '')

    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    const settings = await prisma.reminderSettings.findUnique({
      where: { userId: user.id },
      select: {
        id: true,
        enabled: true,
        beforeDueDays: true,
        afterDueDays: true,
        onDueEnabled: true,
      },
    })

    return NextResponse.json({
      settings: settings
        ? {
            id: settings.id,
            enabled: settings.enabled,
            firstReminderDays: settings.beforeDueDays[0] ?? null,
            secondReminderDays: settings.afterDueDays[0] ?? null,
            sendOnDueDate: settings.onDueEnabled,
          }
        : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'reminder-settings GET error')
    return NextResponse.json(
      { error: 'Failed to get reminder settings' },
      { status: 500 }
    )
  }
}

/* ---------------- PATCH ---------------- */

async function PATCHHandler(request: NextRequest) {
  try {
    const authToken = request.headers
      .get('authorization')
      ?.replace('Bearer ', '')

    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 422 }
      )
    }

    const parsed = reminderSettingsPatchSchema.safeParse(
      normalizeReminderPayload(body)
    )

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid payload',
          fields: formatFieldErrors(parsed.error),
        },
        { status: 422 }
      )
    }

    const payload = parsed.data

    const settings = await prisma.reminderSettings.upsert({
      where: { userId: user.id },
      update: {
        enabled: payload.enabled,
        beforeDueDays: payload.firstReminderDays
          ? [payload.firstReminderDays]
          : undefined,
        afterDueDays: payload.secondReminderDays
          ? [payload.secondReminderDays]
          : undefined,
        onDueEnabled: payload.sendOnDueDate,
      },
      create: {
        userId: user.id,
        enabled:
          payload.enabled ?? DEFAULT_REMINDER_SETTINGS.enabled,
        onDueEnabled:
          payload.sendOnDueDate ??
          DEFAULT_REMINDER_SETTINGS.sendOnDueDate,
        beforeDueDays: [
          payload.firstReminderDays ??
            DEFAULT_REMINDER_SETTINGS.firstReminderDays,
        ],
        afterDueDays: [
          payload.secondReminderDays ??
            DEFAULT_REMINDER_SETTINGS.secondReminderDays,
        ],
      },
    })

    const channel = await persistReminderChannel(user.id, payload)

    return NextResponse.json({
      settings: {
        id: settings.id,
        enabled: settings.enabled,
        firstReminderDays: settings.beforeDueDays[0] ?? null,
        secondReminderDays: settings.afterDueDays[0] ?? null,
        sendOnDueDate: settings.onDueEnabled,
        ...(channel !== undefined ? { channel } : {}),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'reminder-settings PATCH error')
    return NextResponse.json(
      { error: 'Failed to update reminder settings' },
      { status: 500 }
    )
  }
}

/* ---------------- exports ---------------- */

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(
  withBodyLimit(PATCHHandler, {
    limitBytes: 1024 * 1024,
  })
)