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

function isCrossed(direction: string, balance: number, threshold: number): boolean {
  return direction === 'below' ? balance < threshold : balance > threshold
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [alerts, balanceRow] = await Promise.all([
      prisma.balanceThresholdAlert.findMany({
        where: { userId: user.id, enabled: true },
        select: { id: true, currency: true, direction: true, threshold: true, lastTriggeredAt: true },
      }),
      prisma.userWithdrawalBalance.findUnique({
        where: { userId: user.id },
        select: { availableUsdc: true },
      }),
    ])

    const usdc = balanceRow ? Number(balanceRow.availableUsdc) : 0
    const fired: string[] = []
    const now = new Date()

    for (const alert of alerts) {
      const balance = alert.currency === 'USDC' || alert.currency === 'USD' ? usdc : 0
      const threshold = Number(alert.threshold)
      const crossed = isCrossed(alert.direction, balance, threshold)
      if (crossed && !alert.lastTriggeredAt) {
        await prisma.balanceThresholdAlert.update({
          where: { id: alert.id },
          data: { lastTriggeredAt: now },
        })
        fired.push(alert.id)
        continue
      }
      if (!crossed && alert.lastTriggeredAt) {
        await prisma.balanceThresholdAlert.update({
          where: { id: alert.id },
          data: { lastTriggeredAt: null },
        })
      }
    }

    return NextResponse.json({ fired })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/balance-threshold-alerts/evaluate error')
    return NextResponse.json({ error: 'Failed to evaluate alerts' }, { status: 500 })
  }
}
