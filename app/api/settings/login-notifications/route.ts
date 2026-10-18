import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Live in-memory override & in-flight login notification cancellation registry
// so changing notifyOnNewDevice to false takes effect immediately for any login attempt in progress.
const liveNotifyOnNewDeviceState = new Map<string, boolean>()
const inFlightLoginControllers = new Map<string, Set<AbortController>>()

export function registerPendingLoginNotification(userId: string): AbortController {
  const controller = new AbortController()
  if (liveNotifyOnNewDeviceState.get(userId) === false) {
    controller.abort('LOGIN_NOTIFICATIONS_DISABLED')
    return controller
  }
  let set = inFlightLoginControllers.get(userId)
  if (!set) {
    set = new Set()
    inFlightLoginControllers.set(userId, set)
  }
  set.add(controller)
  return controller
}

export function completePendingLoginNotification(
  userId: string,
  controller: AbortController,
): void {
  const set = inFlightLoginControllers.get(userId)
  if (!set) return
  set.delete(controller)
  if (set.size === 0) {
    inFlightLoginControllers.delete(userId)
  }
}

export function cancelPendingLoginNotifications(userId: string): number {
  const set = inFlightLoginControllers.get(userId)
  if (!set || set.size === 0) return 0
  let cancelledCount = 0
  for (const controller of set) {
    if (!controller.signal.aborted) {
      controller.abort('LOGIN_NOTIFICATIONS_DISABLED')
      cancelledCount++
    }
  }
  inFlightLoginControllers.delete(userId)
  return cancelledCount
}

export async function shouldSendNewDeviceNotification(
  userId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false
  if (liveNotifyOnNewDeviceState.has(userId)) {
    return liveNotifyOnNewDeviceState.get(userId)!
  }
  const settings = await prisma.loginNotificationSettings.findUnique({
    where: { userId },
    select: { notifyOnNewDevice: true },
  })
  const enabled = settings ? Boolean(settings.notifyOnNewDevice) : true
  liveNotifyOnNewDeviceState.set(userId, enabled)
  return !signal?.aborted && enabled
}

export function resetLoginNotificationRuntimeState(): void {
  liveNotifyOnNewDeviceState.clear()
  inFlightLoginControllers.clear()
}

function isValidEmail(email: string): boolean {
  if (email.length > 254) return false
  return EMAIL_REGEX.test(email)
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  let userId = claims.userId
  let accountEmail: string | null =
    (claims as { email?: string | null }).email ?? null

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true, email: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, email: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
    accountEmail = dbUser.email ?? accountEmail
  }

  return {
    error: null,
    status: 200 as const,
    user: { id: userId, email: accountEmail },
  }
}

function formatSettingsResponse(
  record: {
    id?: string
    userId: string
    notifyOnNewDevice: boolean
    notifyEmail: string | null
    createdAt?: Date | string | null
    updatedAt?: Date | string | null
  },
  accountEmail: string | null,
  extra?: { cancelledInFlightLogins?: number },
) {
  const effectiveNotifyEmail = record.notifyEmail ?? accountEmail ?? null
  return {
    settings: {
      id: record.id ?? null,
      userId: record.userId,
      notifyOnNewDevice: Boolean(record.notifyOnNewDevice),
      notifyEmail: record.notifyEmail ?? null,
      effectiveNotifyEmail,
      createdAt: record.createdAt
        ? new Date(record.createdAt).toISOString()
        : null,
      updatedAt: record.updatedAt
        ? new Date(record.updatedAt).toISOString()
        : null,
    },
    ...(extra?.cancelledInFlightLogins !== undefined
      ? { cancelledInFlightLogins: extra.cancelledInFlightLogins }
      : {}),
  }
}

/**
 * GET /api/settings/login-notifications
 * Reads new-device login notification settings for the authenticated user.
 * Falls back to the account email when `notifyEmail` is null.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const existing = await prisma.loginNotificationSettings.findUnique({
      where: { userId: auth.user.id },
    })

    const record = existing ?? {
      userId: auth.user.id,
      notifyOnNewDevice: true,
      notifyEmail: null,
    }

    liveNotifyOnNewDeviceState.set(
      auth.user.id,
      Boolean(record.notifyOnNewDevice),
    )

    return NextResponse.json(formatSettingsResponse(record, auth.user.email))
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/settings/login-notifications error')
    return NextResponse.json(
      { error: 'Failed to fetch login notification settings' },
      { status: 500 },
    )
  }
}

/**
 * PATCH /api/settings/login-notifications
 * Updates new-device login notification settings:
 * - Upserts on first PATCH since the row is one-per-user.
 * - Validates `notifyEmail` is a valid email format when supplied, falling back to the account email when null.
 * - Immediately updates in-memory state and cancels any in-flight login notification attempts when `notifyOnNewDevice` is set to `false`.
 */
export async function PATCH(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    const hasNotifyOnNewDevice = 'notifyOnNewDevice' in body
    const hasNotifyEmail = 'notifyEmail' in body

    if (!hasNotifyOnNewDevice && !hasNotifyEmail) {
      return NextResponse.json(
        {
          error:
            'At least one of notifyOnNewDevice or notifyEmail must be provided',
          code: 'EMPTY_UPDATE',
        },
        { status: 400 },
      )
    }

    let notifyOnNewDevice: boolean | undefined
    if (hasNotifyOnNewDevice) {
      if (typeof body.notifyOnNewDevice !== 'boolean') {
        return NextResponse.json(
          {
            error: 'notifyOnNewDevice must be a boolean',
            code: 'INVALID_NOTIFY_ON_NEW_DEVICE',
          },
          { status: 400 },
        )
      }
      notifyOnNewDevice = body.notifyOnNewDevice
    }

    let notifyEmail: string | null | undefined
    if (hasNotifyEmail) {
      if (body.notifyEmail === null || body.notifyEmail === '') {
        notifyEmail = null
      } else if (typeof body.notifyEmail === 'string') {
        const trimmed = body.notifyEmail.trim().toLowerCase()
        if (!isValidEmail(trimmed)) {
          return NextResponse.json(
            {
              error: 'notifyEmail must be a valid email address',
              code: 'INVALID_NOTIFY_EMAIL',
            },
            { status: 400 },
          )
        }
        notifyEmail = trimmed
      } else {
        return NextResponse.json(
          {
            error: 'notifyEmail must be a valid email string or null',
            code: 'INVALID_NOTIFY_EMAIL',
          },
          { status: 400 },
        )
      }
    }

    // Apply immediate live state update BEFORE awaiting DB write so any concurrent login in progress sees it right away
    let cancelledInFlightLogins = 0
    if (notifyOnNewDevice !== undefined) {
      liveNotifyOnNewDeviceState.set(auth.user.id, notifyOnNewDevice)
      if (notifyOnNewDevice === false) {
        cancelledInFlightLogins = cancelPendingLoginNotifications(auth.user.id)
      }
    }

    const updateData: Record<string, unknown> = {}
    if (notifyOnNewDevice !== undefined) {
      updateData.notifyOnNewDevice = notifyOnNewDevice
    }
    if (notifyEmail !== undefined) {
      updateData.notifyEmail = notifyEmail
    }

    const upserted = await prisma.loginNotificationSettings.upsert({
      where: { userId: auth.user.id },
      update: updateData,
      create: {
        userId: auth.user.id,
        notifyOnNewDevice: notifyOnNewDevice ?? true,
        notifyEmail: notifyEmail ?? null,
      },
    })

    liveNotifyOnNewDeviceState.set(
      auth.user.id,
      Boolean(upserted.notifyOnNewDevice),
    )

    return NextResponse.json(
      formatSettingsResponse(upserted, auth.user.email, {
        cancelledInFlightLogins,
      }),
    )
  } catch (err) {
    logger?.error?.({ err }, 'PATCH /api/settings/login-notifications error')
    return NextResponse.json(
      { error: 'Failed to update login notification settings' },
      { status: 500 },
    )
  }
}
