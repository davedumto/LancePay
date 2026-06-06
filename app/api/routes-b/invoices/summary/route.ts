import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getInvoiceStatusSummary } from '../../_lib/aggregations'

async function GETHandler(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const summary = await getInvoiceStatusSummary(user.id)
    return NextResponse.json({ summary })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B invoice summary GET error')
    return NextResponse.json({ error: 'Failed to get invoice summary' }, { status: 500 })
  }
}

export const GET = withRequestId(GETHandler)
