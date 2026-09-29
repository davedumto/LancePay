import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// POST /api/routes-b/automations/[id]/toggle — enable or disable an automation.
// Body (optional): { active?: boolean } — when omitted, toggles the current state.

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function POST(
  request: NextRequest,
  { params }: any,
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const {} = await params
    if (!id || !id.trim()) {
      return NextResponse.json({ error: 'Automation id is required' }, { status: 400 })
    }

    const automation = await prisma.automation.findFirst({
      where: { id, userId: user.id },
      select: { id: true, isActive: true },
    })

    if (!automation) {
      return NextResponse.json({ error: 'Automation not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const payload = (body ?? {}) as Record<string, unknown>

    if (payload.active !== undefined && typeof payload.active !== 'boolean') {
      return NextResponse.json({ error: 'active must be a boolean' }, { status: 400 })
    }

    const newActive = typeof payload.active === 'boolean' ? payload.active : !automation.isActive

    const updated = await prisma.automation.update({
      where: { id },
      data: { isActive: newActive },
      select: { id: true, isActive: true, updatedAt: true },
    })

    return NextResponse.json({
      id: updated.id,
      isActive: updated.isActive,
      updatedAt: updated.updatedAt,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/automations/[id]/toggle error')
    return NextResponse.json({ error: 'Failed to toggle automation' }, { status: 500 })
  }
}
