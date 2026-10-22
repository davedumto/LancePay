import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'

async function getAdmin(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return null

  const claims = await verifyAuthToken(token)
  if (!claims?.userId) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true, role: true },
  })

  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return null
  return user
}

/**
 * POST /api/admin/users/[id]/impersonate/revoke
 *
 * Revokes an active impersonation session immediately. The persisted
 * `revokedAt` value is the audit record consumed by session validation.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: targetUserId } = await params
    if (!targetUserId?.trim()) {
      return NextResponse.json({ error: 'Target user ID is required' }, { status: 400 })
    }

    const admin = await getAdmin(request)
    if (!admin) {
      return NextResponse.json(
        { error: 'Forbidden: platform admin access required', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    let body: { sessionId?: unknown; reason?: unknown } = {}
    try {
      const parsed = await request.json()
      if (parsed && typeof parsed === 'object') body = parsed
    } catch {
      // An empty body is valid: revoke the active session for the target user.
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined
    const session = await prisma.impersonationSession.findFirst({
      where: {
        targetUserId,
        ...(sessionId ? { id: sessionId } : {}),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, adminId: true, targetUserId: true, expiresAt: true },
    })

    if (!session) {
      return NextResponse.json(
        { error: 'Active impersonation session not found', code: 'SESSION_NOT_FOUND' },
        { status: 404 },
      )
    }

    if (session.adminId !== admin.id && admin.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Only the session owner or an override admin may revoke this session', code: 'REVOCATION_FORBIDDEN' },
        { status: 403 },
      )
    }

    const revokedAt = new Date()
    const revoked = await prisma.impersonationSession.update({
      where: { id: session.id },
      data: { revokedAt },
      select: { id: true, targetUserId: true, revokedAt: true },
    })

    logger.info(
      { sessionId: revoked.id, targetUserId, adminId: admin.id, reason },
      'Admin revoked impersonation session',
    )

    return NextResponse.json({
      sessionId: revoked.id,
      targetUserId: revoked.targetUserId,
      revokedAt: revoked.revokedAt.toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/admin/users/[id]/impersonate/revoke error')
    return NextResponse.json({ error: 'Failed to revoke impersonation session' }, { status: 500 })
  }
}
