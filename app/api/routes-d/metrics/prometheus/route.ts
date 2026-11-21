import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

// GET /api/routes-d/metrics/prometheus — expose application metrics in Prometheus text format

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (!isAdmin(user as { role?: string; email?: string | null })) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const [userCount, transactionCount] = await Promise.all([
      prisma.user.count(),
      prisma.transaction.count(),
    ])

    const lines = [
      '# HELP lancepay_users_total Total registered users',
      '# TYPE lancepay_users_total gauge',
      `lancepay_users_total ${userCount}`,
      '',
      '# HELP lancepay_transactions_total Total transactions recorded',
      '# TYPE lancepay_transactions_total gauge',
      `lancepay_transactions_total ${transactionCount}`,
      '',
    ]

    logger.info({ userId: user.id }, 'GET /api/routes-d/metrics/prometheus')
    return new NextResponse(lines.join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/metrics/prometheus error')
    return NextResponse.json({ error: 'Failed to collect metrics' }, { status: 500 })
  }
}
