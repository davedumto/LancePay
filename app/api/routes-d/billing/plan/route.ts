import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const PLAN_DETAILS: Record<
  string,
  { displayName: string; monthlyPriceCents: number; features: string[] }
> = {
  free: {
    displayName: 'Free',
    monthlyPriceCents: 0,
    features: ['10 invoices/month', '1,000 API calls/month', '100 MB storage'],
  },
  starter: {
    displayName: 'Starter',
    monthlyPriceCents: 1900,
    features: ['100 invoices/month', '10,000 API calls/month', '1 GB storage'],
  },
  pro: {
    displayName: 'Pro',
    monthlyPriceCents: 4900,
    features: ['1,000 invoices/month', '100,000 API calls/month', '10 GB storage', 'Priority support'],
  },
  enterprise: {
    displayName: 'Enterprise',
    monthlyPriceCents: -1,
    features: ['Unlimited invoices', 'Unlimited API calls', 'Unlimited storage', 'Dedicated support'],
  },
}

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

    const planKey = user.subscription?.plan ?? 'free'
    const details = PLAN_DETAILS[planKey] ?? PLAN_DETAILS.free

    return NextResponse.json({
      plan: planKey,
      displayName: details.displayName,
      monthlyPriceCents: details.monthlyPriceCents,
      features: details.features,
      renewsAt: user.subscription?.renewsAt ?? null,
      status: user.subscription?.status ?? 'active',
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /billing/plan error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
