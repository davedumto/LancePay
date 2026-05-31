import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import { getCacheValue, setCacheValue } from '../../_lib/cache'
import { computeTrustScoreComponents } from '../../_lib/trust-score-components'

const TRUST_SCORE_COOLDOWN_MS = 30_000

type ExplainPayload = {
  score: number
  components: Array<{
    name: string
    weight: number
    contribution: number
    currentValue: number
  }>
}

async function GETHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const force = request.nextUrl.searchParams.get('force') === 'true'

    if (force && auth.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 })
    }

    const cacheKey = `routes-b:trust-score-explain:${auth.userId}`
    if (!force) {
      const cached = getCacheValue<ExplainPayload>(cacheKey)
      if (cached) {
        return NextResponse.json(cached, { headers: { 'X-Cache': 'HIT' } })
      }
    }

    const [paidAgg, successfulInvoices, disputes] = await Promise.all([
      prisma.invoice.aggregate({
        where: { userId: auth.userId, status: 'paid' },
        _sum: { amount: true },
      }),
      prisma.invoice.count({ where: { userId: auth.userId, status: 'paid' } }),
      prisma.dispute.count({
        where: { invoice: { userId: auth.userId } },
      }),
    ])

    const totalVolumeUsdc = Number(paidAgg._sum.amount ?? 0)
    const { score, components } = computeTrustScoreComponents(
      totalVolumeUsdc,
      successfulInvoices,
      disputes,
    )

    const payload: ExplainPayload = { score, components }
    setCacheValue(cacheKey, payload, TRUST_SCORE_COOLDOWN_MS)

    return NextResponse.json(payload, { headers: { 'X-Cache': 'MISS' } })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return NextResponse.json({ error: 'Forbidden', code: error.code }, { status: 403 })
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export const GET = withRequestId(GETHandler)
