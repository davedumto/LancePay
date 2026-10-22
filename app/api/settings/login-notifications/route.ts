import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'

// GET  /api/settings/login-notifications
// PATCH /api/settings/login-notifications
//
// Manages the single LoginNotificationSettings row per user (one-per-user).
// The row is created on the first PATCH via upsert.
//
// GET  — returns current settings, or defaults if no row exists yet.
// PATCH — partial update; at least one field required.
//         notifyOnNewDevice: boolean
//         notifyEmail: string (valid email) | null (falls back to account email)
//
// Authorization: the authenticated user manages their own settings only.

const DEFAULTS = {
  notifyOnNewDevice: true,
  notifyEmail: null as string | null,
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const settings = await prisma.loginNotificationSettings.findUnique({
      where: { userId: user.id },
    })

    return NextResponse.json({
      settings: settings
        ? {
            notifyOnNewDevice: settings.notifyOnNewDevice,
            notifyEmail: settings.notifyEmail,
            updatedAt: settings.updatedAt,
          }
        : { ...DEFAULTS, updatedAt: null },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/settings/login-notifications error')
    return NextResponse.json({ error: 'Failed to fetch login notification settings' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { notifyOnNewDevice, notifyEmail } = body
    const updates: Record<string, unknown> = {}

    if (notifyOnNewDevice !== undefined) {
      if (typeof notifyOnNewDevice !== 'boolean') {
        return NextResponse.json(
          { error: 'notifyOnNewDevice must be a boolean' },
          { status: 400 },
        )
      }
      updates.notifyOnNewDevice = notifyOnNewDevice
    }

    if (notifyEmail !== undefined) {
      if (notifyEmail !== null) {
        if (typeof notifyEmail !== 'string' || !EMAIL_RE.test(notifyEmail)) {
          return NextResponse.json(
            { error: 'notifyEmail must be a valid email address or null' },
            { status: 400 },
          )
        }
      }
      updates.notifyEmail = notifyEmail
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'At least one field must be provided' },
        { status: 400 },
      )
    }

    // Upsert: creates the row on first call, updates on subsequent calls.
    // Changing notifyOnNewDevice to false takes effect immediately since
    // any in-progress login check will re-read this row from the database.
    const settings = await prisma.loginNotificationSettings.upsert({
      where: { userId: user.id },
      update: updates,
      create: { userId: user.id, ...DEFAULTS, ...updates },
    })

    return NextResponse.json({
      settings: {
        notifyOnNewDevice: settings.notifyOnNewDevice,
        notifyEmail: settings.notifyEmail,
        updatedAt: settings.updatedAt,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/settings/login-notifications error')
    return NextResponse.json({ error: 'Failed to update login notification settings' }, { status: 500 })
  }
}
