import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    // Verify auth
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Run queries in parallel
    const [draft, pending, paid, cancelled, total] = await Promise.all([
      prisma.invoice.count({
        where: { userId: user.id, status: 'draft' },
      }),
      prisma.invoice.count({
        where: { userId: user.id, status: 'pending' },
      }),
      prisma.invoice.count({
        where: { userId: user.id, status: 'paid' },
      }),
      prisma.invoice.count({
        where: { userId: user.id, status: 'cancelled' },
      }),
      prisma.invoice.count({
        where: { userId: user.id },
      }),
    ])

    return NextResponse.json({
      draft,
      pending,
      paid,
      cancelled,
      total,
    })
  } catch (error) {
    logger.error({ err: error }, 'Invoice analytics error')
    return NextResponse.json({ error: 'Failed to get invoice analytics' }, { status: 500 })
  }
}