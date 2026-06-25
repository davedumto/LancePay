import { withRequestId } from '../../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function POSTHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  let body: { code?: unknown; redirectUri?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { code, redirectUri } = body
  if (typeof code !== 'string' || !code.trim()) {
    return NextResponse.json({ error: 'code is required' }, { status: 422 })
  }

  const existing = await prisma.integration.findFirst({
    where: { userId: user.id, type: 'stripe' },
  })
  if (existing?.enabled) {
    return NextResponse.json(
      { error: 'Stripe account already connected' },
      { status: 409 },
    )
  }

  const integration = await prisma.integration.upsert({
    where: { userId_type: { userId: user.id, type: 'stripe' } },
    create: {
      userId: user.id,
      type: 'stripe',
      config: { code, redirectUri: redirectUri ?? null, connectedAt: new Date().toISOString() },
      enabled: true,
    },
    update: {
      config: { code, redirectUri: redirectUri ?? null, connectedAt: new Date().toISOString() },
      enabled: true,
    },
    select: { id: true, type: true, enabled: true, updatedAt: true },
  })

  logger.info({ userId: user.id, integrationId: integration.id }, 'Stripe account connected')

  return NextResponse.json({ integration }, { status: 201 })
}

export const POST = withRequestId(POSTHandler)
