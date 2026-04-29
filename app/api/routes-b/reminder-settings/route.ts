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

/**
 * FORMAT VALIDATION ERRORS
 */
function formatFieldErrors(error: {
  issues: Array<{ path: Array<string | number>; message: string }>
}) {
  return error.issues.reduce<Record<string, string>>((fields, issue) => {
    const key = typeof issue.path[0] === 'string' ? issue.path[0] : 'body'
    if (!fields[key]) fields[key] = issue.message
    return fields
  }, {})
}

/**
 * NORMALIZE INPUT PAYLOAD
 */
function normalizeReminderPayload(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input

  const body = { ...(input as Record<string, unknown>) }

  if (!Object.prototype.hasOwnProperty.call(body, 'firstReminderDays') && body.sendDaysBefore !== undefined) {
    body.firstReminderDays = body.sendDaysBefore
  }

  if (!Object.prototype.hasOwnProperty.call(body, 'secondReminderDays') && body.sendDaysAfter !== undefined) {
    body.secondReminderDays = body.sendDaysAfter
  }

  return body
}

/**
 * AUTH
 */
async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) return null

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
  })
}

/**
 * OPTIONAL CHANNEL UPDATE
 */
async function persistReminderChannel(
  userId: string,
  payload: ReminderSettingsPatchPayload
) {
  if (!Object.prototype.hasOwnProperty.call(payload, 'channel')) return undefined

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

/**
 * GET SETTINGS
 */
async function GETHandler(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
            sendDaysBefore: settings.beforeDueDays[0] ?? null,
            sendDaysAfter: settings.afterDueDays[0] ?? null,
          }
        : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET reminder settings error')
    return NextResponse.json(
      { error: 'Failed to get reminder settings' },
      { status: 500 }
    )
  }
}

/**
 * PATCH SETTINGS
 */
async function PATCHHandler(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body', fields: { body: 'Must be valid JSON' } },
        { status: 422 }
      )
    }

    const parsed = reminderSettingsPatchSchema.safeParse(
      normalizeReminderPayload(body)
    )

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid reminder settings payload',
          fields: formatFieldErrors(parsed.error),
        },
        { status: 422 }
      )
    }

    const existing = await prisma.reminderSettings.findUnique({
      where: { userId: user.id },
      select: {
        beforeDueDays: true,
        afterDueDays: true,
      },
    })

    const payload = parsed.data
    const isFirstPatch = !existing

    const createPayload: ReminderSettingsPatchPayload = {
      ...DEFAULT_REMINDER_SETTINGS,
      ...payload,
    }

    const first =
      payload.firstReminderDays ??
      existing?.beforeDueDays[0] ??
      DEFAULT_REMINDER_SETTINGS.firstReminderDays

    const second =
      payload.secondReminderDays ??
      existing?.afterDueDays[0] ??
      DEFAULT_REMINDER_SETTINGS.secondReminderDays

    if (second <= first) {
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

    if ('enabled' in writePayload) updateData.enabled = writePayload.enabled
    if ('firstReminderDays' in writePayload)
      updateData.beforeDueDays = [writePayload.firstReminderDays as number]
    if ('secondReminderDays' in writePayload)
      updateData.afterDueDays = [writePayload.secondReminderDays as number]
    if ('sendOnDueDate' in writePayload)
      updateData.onDueEnabled = writePayload.sendOnDueDate

    const settings = await prisma.reminderSettings.upsert({
      where: { userId: user.id },
      update: updateData,
      create: {
        userId: user.id,
        enabled: createPayload.enabled,
        onDueEnabled: createPayload.sendOnDueDate,
        beforeDueDays: [createPayload.firstReminderDays],
        afterDueDays: [createPayload.secondReminderDays],
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

    return NextResponse.json({
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
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH reminder settings error')
    return NextResponse.json(
      { error: 'Failed to update reminder settings' },
      { status: 500 }
    )
  }
}

/**
 * EXPORT
 */
export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)