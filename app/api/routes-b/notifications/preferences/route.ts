import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import { notificationPreferencesSchema } from '../preferences-schema'

const DEFAULTS = { invoicePaid: true, invoiceOverdue: true, withdrawalCompleted: true, securityAlert: true, marketing: true }

function parsePrefs(raw?: string | null) {
  if (!raw) return DEFAULTS
  try {
    return { ...DEFAULTS, ...(JSON.parse(raw)?.routesBNotificationPreferences ?? {}) }
  } catch {
    return DEFAULTS
  }
}

async function GETHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const settings = await prisma.reminderSettings.findUnique({ where: { userId: auth.userId }, select: { customMessage: true } })
    return NextResponse.json(parsePrefs(settings?.customMessage))
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) return NextResponse.json({ error: 'Forbidden', code: error.code }, { status: 403 })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

async function PATCHHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const body = await request.json()
    const patch = notificationPreferencesSchema.parse(body)

    const existing = await prisma.reminderSettings.findUnique({ where: { userId: auth.userId }, select: { id: true, customMessage: true } })
    const current = parsePrefs(existing?.customMessage)
    const next = { ...current, ...patch, securityAlert: true }
    const payload = JSON.stringify({ routesBNotificationPreferences: next })

    if (existing) {
      await prisma.reminderSettings.update({ where: { id: existing.id }, data: { customMessage: payload } })
    } else {
      await prisma.reminderSettings.create({ data: { userId: auth.userId, customMessage: payload } })
    }

    return NextResponse.json(next)
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) return NextResponse.json({ error: 'Forbidden', code: error.code }, { status: 403 })
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)
