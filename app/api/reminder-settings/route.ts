import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const DEFAULT_REMINDER_SETTINGS = {
  enabled: true,
  beforeDueDays: [3, 1],
  onDueEnabled: true,
  afterDueDays: [1, 3, 7],
  customMessage: null as string | null,
}

export function validateDaysOffsetArray(
  fieldName: string,
  value: unknown,
): { valid: boolean; normalized?: number[]; error?: string } {
  if (!Array.isArray(value)) {
    return {
      valid: false,
      error: `${fieldName} must be an array of non-negative integers`,
    }
  }

  const normalized: number[] = []
  for (const item of value) {
    if (
      typeof item !== 'number' ||
      !Number.isInteger(item) ||
      item < 0
    ) {
      return {
        valid: false,
        error: `${fieldName} must contain only non-negative integers (>= 0)`,
      }
    }
    normalized.push(item)
  }

  return { valid: true, normalized }
}

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

function serializeReminderSettings(
  record: Record<string, any> | null,
  userId: string,
) {
  if (!record) {
    return {
      id: null,
      userId,
      enabled: DEFAULT_REMINDER_SETTINGS.enabled,
      beforeDueDays: [...DEFAULT_REMINDER_SETTINGS.beforeDueDays],
      onDueEnabled: DEFAULT_REMINDER_SETTINGS.onDueEnabled,
      afterDueDays: [...DEFAULT_REMINDER_SETTINGS.afterDueDays],
      customMessage: DEFAULT_REMINDER_SETTINGS.customMessage,
      isDefault: true,
      createdAt: null,
      updatedAt: null,
    }
  }

  return {
    id: record.id ?? null,
    userId: record.userId ?? userId,
    enabled:
      record.enabled !== undefined
        ? Boolean(record.enabled)
        : DEFAULT_REMINDER_SETTINGS.enabled,
    beforeDueDays: Array.isArray(record.beforeDueDays)
      ? record.beforeDueDays
      : [...DEFAULT_REMINDER_SETTINGS.beforeDueDays],
    onDueEnabled:
      record.onDueEnabled !== undefined
        ? Boolean(record.onDueEnabled)
        : DEFAULT_REMINDER_SETTINGS.onDueEnabled,
    afterDueDays: Array.isArray(record.afterDueDays)
      ? record.afterDueDays
      : [...DEFAULT_REMINDER_SETTINGS.afterDueDays],
    customMessage: record.customMessage ?? null,
    isDefault: false,
    createdAt: record.createdAt
      ? new Date(record.createdAt).toISOString()
      : null,
    updatedAt: record.updatedAt
      ? new Date(record.updatedAt).toISOString()
      : null,
  }
}

/**
 * GET /api/reminder-settings
 * Returns the authenticated user's current effective `ReminderSettings`,
 * falling back to schema defaults if no row exists yet.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const existing =
      typeof prisma.reminderSettings?.findUnique === 'function'
        ? await prisma.reminderSettings.findUnique({
            where: { userId: user.id },
          })
        : await prisma.reminderSettings?.findFirst?.({
            where: { userId: user.id },
          })

    return NextResponse.json({
      reminderSettings: serializeReminderSettings(existing ?? null, user.id),
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/reminder-settings error')
    return NextResponse.json(
      { error: 'Failed to fetch reminder settings' },
      { status: 500 },
    )
  }
}

/**
 * PATCH /api/reminder-settings
 * Updates or creates (`upsert`) the authenticated user's `ReminderSettings`:
 * - Upserts on first `PATCH` rather than requiring a separate creation step.
 * - Validates `beforeDueDays` and `afterDueDays` arrays contain only non-negative integers.
 */
export async function PATCH(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const updateData: Record<string, unknown> = {}

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return NextResponse.json(
          { error: 'enabled must be a boolean', code: 'INVALID_ENABLED' },
          { status: 400 },
        )
      }
      updateData.enabled = body.enabled
    }

    if (body.onDueEnabled !== undefined) {
      if (typeof body.onDueEnabled !== 'boolean') {
        return NextResponse.json(
          {
            error: 'onDueEnabled must be a boolean',
            code: 'INVALID_ON_DUE_ENABLED',
          },
          { status: 400 },
        )
      }
      updateData.onDueEnabled = body.onDueEnabled
    }

    if (body.beforeDueDays !== undefined) {
      const check = validateDaysOffsetArray(
        'beforeDueDays',
        body.beforeDueDays,
      )
      if (!check.valid) {
        return NextResponse.json(
          {
            error: check.error,
            code: 'INVALID_BEFORE_DUE_DAYS',
          },
          { status: 400 },
        )
      }
      updateData.beforeDueDays = check.normalized
    }

    if (body.afterDueDays !== undefined) {
      const check = validateDaysOffsetArray('afterDueDays', body.afterDueDays)
      if (!check.valid) {
        return NextResponse.json(
          {
            error: check.error,
            code: 'INVALID_AFTER_DUE_DAYS',
          },
          { status: 400 },
        )
      }
      updateData.afterDueDays = check.normalized
    }

    if (body.customMessage !== undefined) {
      if (
        body.customMessage !== null &&
        typeof body.customMessage !== 'string'
      ) {
        return NextResponse.json(
          {
            error: 'customMessage must be a string or null',
            code: 'INVALID_CUSTOM_MESSAGE',
          },
          { status: 400 },
        )
      }
      updateData.customMessage =
        typeof body.customMessage === 'string'
          ? body.customMessage.trim() || null
          : null
    }

    const createData = {
      userId: user.id,
      enabled:
        (updateData.enabled as boolean | undefined) ??
        DEFAULT_REMINDER_SETTINGS.enabled,
      beforeDueDays:
        (updateData.beforeDueDays as number[] | undefined) ?? [
          ...DEFAULT_REMINDER_SETTINGS.beforeDueDays,
        ],
      onDueEnabled:
        (updateData.onDueEnabled as boolean | undefined) ??
        DEFAULT_REMINDER_SETTINGS.onDueEnabled,
      afterDueDays:
        (updateData.afterDueDays as number[] | undefined) ?? [
          ...DEFAULT_REMINDER_SETTINGS.afterDueDays,
        ],
      customMessage:
        (updateData.customMessage as string | null | undefined) ??
        DEFAULT_REMINDER_SETTINGS.customMessage,
    }

    let upserted: Record<string, any>
    if (typeof prisma.reminderSettings?.upsert === 'function') {
      upserted = await prisma.reminderSettings.upsert({
        where: { userId: user.id },
        create: createData,
        update: updateData,
      })
    } else {
      const existing = await prisma.reminderSettings.findUnique({
        where: { userId: user.id },
      })
      if (existing) {
        upserted = await prisma.reminderSettings.update({
          where: { userId: user.id },
          data: updateData,
        })
      } else {
        upserted = await prisma.reminderSettings.create({
          data: createData,
        })
      }
    }

    return NextResponse.json({
      reminderSettings: serializeReminderSettings(upserted, user.id),
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'PATCH /api/reminder-settings error')
    return NextResponse.json(
      { error: 'Failed to update reminder settings' },
      { status: 500 },
    )
  }
}
