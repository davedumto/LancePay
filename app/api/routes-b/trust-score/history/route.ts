import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import {
  ALLOWED_RANGE_DAYS,
  getTrustScoreHistory,
  isAllowedRange,
} from '../../_lib/trust-score-history'

const DEFAULT_DAYS = 30

async function GETHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    const raw = request.nextUrl.searchParams.get('days')
    let days: number = DEFAULT_DAYS
    if (raw !== null) {
      const parsed = Number.parseInt(raw, 10)
      if (!isAllowedRange(parsed)) {
        return NextResponse.json(
          {
            error: `days must be one of ${ALLOWED_RANGE_DAYS.join(', ')}`,
            code: 'INVALID_RANGE',
          },
          { status: 400 },
        )
      }
      days = parsed
    }

    const history = getTrustScoreHistory(auth.userId, days)

    return NextResponse.json({ days, history })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return NextResponse.json({ error: 'Forbidden', code: error.code }, { status: 403 })
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export const GET = withRequestId(GETHandler)
