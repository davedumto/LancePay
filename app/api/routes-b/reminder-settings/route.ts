import { withRequestId } from '../_lib/with-request-id'
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

function formatFieldErrors(error: { issues: Array<{ path: Array<string | number>; message: string }> }) {
  return error.issues.reduce<Record<string, string>>((fields, issue) => {
    const key = typeof issue.path[0] === 'string' ? issue.path[0] : 'body'
    if (!fields[key]) {
      fields[key] = issue.message
    }
    return fields
  }, {})
}

function normalizeReminderPayload(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input
  }

  const body = { ...(input as Record<string, unknown>) }

  if (!Object.prototype.hasOwnProperty.call(body, 'firstReminderDays') && body.sendDaysBefore !== undefined) {
    body.firstReminderDays = body.sendDaysBefore
  }

  if (!Object.prototype.hasOwnProperty.call(body, 'secondReminderDays') && body.sendDaysAfter !== undefined) {
    body.secondReminderDays = body.sendDaysAfter
  }

  return body
}

async function persistReminderChannel(userId: string, payload: ReminderSettingsPatchPayload) {
  if (!Object.prototype.hasOwnProperty.call(payload, 'channel')) {
    return undefined
  }

  const channelSupported = await hasTableColumn('ReminderSettings', 'channel')
  if (!channelSupported) {
    return undefined
  }

  await prisma.$executeRaw`
    UPDATE "ReminderSettings"
    SET "channel" = ${payload.channel},
        "updatedAt" = NOW()
    WHERE "userId" = ${userId}
  `

  return payload.channel
}

async function GETHandler(request: NextRequest) {
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
            sendDaysBefore: settings.beforeDueDays[0] ?? null,
            sendDaysAfter: settings.afterDueDays[0] ?? null,
          }
        : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes B reminder-settings GET error')
    return NextResponse.json({ error: 'Failed to get reminder settings' }, { status: 500 })
  }
}

async function PATCHHandler(request: NextRequest) {
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

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body', fields: { body: 'Body must be valid JSON' } },
        { status: 422 }
      )
    }

    const parsed = reminderSettingsPatchSchema.safeParse(normalizeReminderPayload(body))
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid reminder settings payload',
          fields: formatFieldErrors(parsed.error),
        },
        { status: 422 }
      )
    }

    const existingSettings = await prisma.reminderSettings.findUnique({
      where: { userId: user.id },
      select: {
        id: true,
        enabled: true,
        beforeDueDays: true,
        afterDueDays: true,
        onDueEnabled: true,
      },
    })

    const payload = parsed.data
    const isFirstPatch = !existingSettings
    const createPayload: ReminderSettingsPatchPayload = {
      ...DEFAULT_REMINDER_SETTINGS,
      ...payload,
    }
    const effectiveFirstReminderDays =
      payload.firstReminderDays ??
      existingSettings?.beforeDueDays[0] ??
      DEFAULT_REMINDER_SETTINGS.firstReminderDays
    const effectiveSecondReminderDays =
      payload.secondReminderDays ??
      existingSettings?.afterDueDays[0] ??
      DEFAULT_REMINDER_SETTINGS.secondReminderDays

    if (effectiveSecondReminderDays <= effectiveFirstReminderDays) {
      return NextResponse.json(
        {
          error: 'Invalid reminder settings payload',
          fields: {
            secondReminderDays: 'Must be greater than firstReminderDays',
          },
        },
        { status: 422 }
      )
    }

    const updateData: {
      enabled?: boolean
      beforeDueDays?: number[]
      afterDueDays?: number[]
      onDueEnabled?: boolean
    } = {}

    const writePayload = isFirstPatch ? createPayload : payload

    if (Object.prototype.hasOwnProperty.call(writePayload, 'enabled')) {
      updateData.enabled = writePayload.enabled
    }
    if (Object.prototype.hasOwnProperty.call(writePayload, 'firstReminderDays')) {
      updateData.beforeDueDays = [writePayload.firstReminderDays as number]
    }
    if (Object.prototype.hasOwnProperty.call(writePayload, 'secondReminderDays')) {
      updateData.afterDueDays = [writePayload.secondReminderDays as number]
    }
    if (Object.prototype.hasOwnProperty.call(writePayload, 'sendOnDueDate')) {
      updateData.onDueEnabled = writePayload.sendOnDueDate
    }

    const settings = await prisma.reminderSettings.upsert({
      where: { userId: user.id },
      update: updateData,
      create: {
        userId: user.id,
        enabled: createPayload.enabled ?? DEFAULT_REMINDER_SETTINGS.enabled,
        onDueEnabled: createPayload.sendOnDueDate ?? DEFAULT_REMINDER_SETTINGS.sendOnDueDate,
        beforeDueDays: [createPayload.firstReminderDays ?? DEFAULT_REMINDER_SETTINGS.firstReminderDays],
        afterDueDays: [createPayload.secondReminderDays ?? DEFAULT_REMINDER_SETTINGS.secondReminderDays],
      },
      select: {
        id: true,
        enabled: true,
        onDueEnabled: true,
        beforeDueDays: true,
        afterDueDays: true,
      },
    })

    const channel = await persistReminderChannel(user.id, writePayload)

    return NextResponse.json(
      {
        settings: {
          id: settings.id,
          enabled: settings.enabled,
          ...(channel !== undefined ? { channel } : {}),
          firstReminderDays: settings.beforeDueDays[0] ?? null,
          secondReminderDays: settings.afterDueDays[0] ?? null,
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

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)
