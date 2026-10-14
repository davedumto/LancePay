import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const webhookId = searchParams.get('webhookId')
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100)

    const where = webhookId ? { webhookId } : {}
    const deliveries = await (prisma as any).webhookDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        webhook: { select: { targetUrl: true, eventTypes: true } },
      },
    })

    return NextResponse.json({
      deliveries,
      count: deliveries.length,
      filters: { webhookId: webhookId ?? null, limit },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/admin/webhooks/debugger error')
    return NextResponse.json({ error: 'Failed to fetch webhook debug view' }, { status: 500 })
  }
}
