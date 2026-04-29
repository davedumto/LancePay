import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getWidgetConfig, patchWidgetConfig } from '../../_lib/dashboard-widgets'

// ── GET /api/routes-b/dashboard/widgets ─────────────────────────────

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const config = getWidgetConfig(user.id)
  return NextResponse.json({ widgets: config })
}

// ── PATCH /api/routes-b/dashboard/widgets ───────────────────────────

export async function PATCH(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const body = await request.json()

  if (body.order !== undefined && !Array.isArray(body.order)) {
    return NextResponse.json({ error: 'order must be an array of widget ids' }, { status: 400 })
  }
  if (body.hidden !== undefined && !Array.isArray(body.hidden)) {
    return NextResponse.json({ error: 'hidden must be an array of widget ids' }, { status: 400 })
  }
  if (body.order === undefined && body.hidden === undefined) {
    return NextResponse.json({ error: 'At least one of order or hidden is required' }, { status: 400 })
  }

  const result = patchWidgetConfig(user.id, {
    order: body.order,
    hidden: body.hidden,
  })

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, unknownIds: result.unknownIds },
      { status: 422 },
    )
  }

  return NextResponse.json({ widgets: result.config })
}
