import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

async function findOwnedClient(clientId: string, userId: string) {
  const client = await prisma.user.findFirst({
    where: { id: clientId },
    select: { id: true },
  })
  if (!client) return null

  const hasInvoiceRelationship = await prisma.invoice.findFirst({
    where: { clientId, userId },
    select: { id: true },
  })
  if (!hasInvoiceRelationship) return null

  return client
}

/**
 * POST /api/clients/[id]/portal-sessions/[sessionId]/revoke
 * Revoke a specific portal session for a client.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
) {
  try {
    const { id: clientId, sessionId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!clientId || !clientId.trim()) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 })
    }

    if (!sessionId || !sessionId.trim()) {
      return NextResponse.json({ error: 'Session ID is required' }, { status: 400 })
    }

    const client = await findOwnedClient(clientId, user.id)
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const session = await prisma.clientPortalSession.findFirst({
      where: {
        id: sessionId,
        userId: user.id,
        clientId,
      },
      select: {
        id: true,
        revokedAt: true,
        expiresAt: true,
      },
    })

    if (!session) {
      return NextResponse.json({ error: 'Portal session not found' }, { status: 404 })
    }

    const now = new Date()
    const isExpired = session.expiresAt && session.expiresAt.getTime() <= now.getTime()

    if (session.revokedAt) {
      return NextResponse.json(
        {
          session: {
            id: session.id,
            status: 'revoked',
            revokedAt: session.revokedAt.toISOString(),
          },
        },
        { status: 409 },
      )
    }

    if (isExpired) {
      return NextResponse.json(
        {
          session: {
            id: session.id,
            status: 'expired',
            expiresAt: session.expiresAt!.toISOString(),
          },
        },
        { status: 409 },
      )
    }

    const revoked = await prisma.clientPortalSession.update({
      where: { id: sessionId },
      data: { revokedAt: now },
      select: {
        id: true,
        revokedAt: true,
      },
    })

    return NextResponse.json({
      session: {
        id: revoked.id,
        status: 'revoked',
        revokedAt: revoked.revokedAt!.toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/clients/[id]/portal-sessions/[sessionId]/revoke error')
    return NextResponse.json({ error: 'Failed to revoke portal session' }, { status: 500 })
  }
}
