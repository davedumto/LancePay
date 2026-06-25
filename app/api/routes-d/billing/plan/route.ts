import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const plan = await prisma.subscription.findFirst({
      where: {
        userId: user.id,
        status: 'active',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        frequency: true,
        interval: true,
        amount: true,
        currency: true,
        clientEmail: true,
        clientName: true,
        description: true,
        nextGenerationDate: true,
        lastGeneratedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({
      plan: plan
        ? {
            ...plan,
            amount: Number(plan.amount),
          }
        : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes D billing plan GET error')
    return NextResponse.json({ error: 'Failed to get billing plan' }, { status: 500 })
  }
}
