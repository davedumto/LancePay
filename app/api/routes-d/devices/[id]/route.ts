import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── DELETE /api/routes-d/devices/[id] — remove a registered device ──
//
// A "device" is a UserSession row. Removing a device revokes the session
// (soft-delete via revokedAt) so the audit trail is preserved. Callers
// can only remove devices that belong to their own account.

type UserSessionDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getSessionDelegate(): UserSessionDelegate {
  return (prisma as unknown as { userSession: UserSessionDelegate }).userSession
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const delegate = getSessionDelegate()

    const session = await delegate.findUnique({
      where: { id },
      select: { id: true, userId: true, revokedAt: true },
    })

    if (!session) {
      return NextResponse.json({ error: 'Device not found' }, { status: 404 })
    }

    if ((session as { userId: string }).userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if ((session as { revokedAt: Date | null }).revokedAt !== null) {
      return NextResponse.json({ error: 'Device already removed' }, { status: 409 })
    }

    await delegate.update({
      where: { id },
      data: { revokedAt: new Date() },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-d/devices/[id] error')
    return NextResponse.json({ error: 'Failed to remove device' }, { status: 500 })
  }
}
