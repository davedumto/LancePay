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

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      include: { subscription: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    const now = new Date()
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const [invoiceCount, apiCallCount, storageBytes] = await Promise.all([
      prisma.invoice.count({ where: { userId: user.id, createdAt: { gte: periodStart } } }),
      prisma.apiUsageLog.count({ where: { userId: user.id, createdAt: { gte: periodStart } } }),
      prisma.storageUsage.aggregate({
        _sum: { bytes: true },
        where: { userId: user.id },
      }),
    ])

    const plan = user.subscription?.plan ?? 'free'
    const limits = getPlanLimits(plan)

    return NextResponse.json({
      period: { start: periodStart.toISOString(), end: now.toISOString() },
      plan,
      usage: {
        invoices: { used: invoiceCount, limit: limits.invoices },
        apiCalls: { used: apiCallCount, limit: limits.apiCalls },
        storageMb: {
          used: Math.round((storageBytes._sum.bytes ?? 0) / (1024 * 1024)),
          limit: limits.storageMb,
        },
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /billing/usage error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

function getPlanLimits(plan: string) {
  const limits: Record<string, { invoices: number; apiCalls: number; storageMb: number }> = {
    free: { invoices: 10, apiCalls: 1_000, storageMb: 100 },
    starter: { invoices: 100, apiCalls: 10_000, storageMb: 1_024 },
    pro: { invoices: 1_000, apiCalls: 100_000, storageMb: 10_240 },
    enterprise: { invoices: -1, apiCalls: -1, storageMb: -1 },
  }
  return limits[plan] ?? limits.free
}
