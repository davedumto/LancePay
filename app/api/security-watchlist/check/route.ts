import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { isAdmin } from '@/lib/authorization'
import { logger } from '@/lib/logger'

type ComplianceActorResult =
  | { user: { id: string; role: string; email: string } }
  | { response: NextResponse }

async function requireComplianceActor(request: NextRequest): Promise<ComplianceActorResult> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = authToken ? await verifyAuthToken(authToken) : null
  if (!claims) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true, email: true },
  })
  if (!user) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!isAdmin(user) && user.role !== 'compliance') {
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { user }
}

export async function GET(request: NextRequest) {
  try {
    const actor = await requireComplianceActor(request)
    if ('response' in actor) return actor.response

    const value = new URL(request.url).searchParams.get('value')?.trim()
    if (!value) return NextResponse.json({ error: 'value is required' }, { status: 400 })

    const entry = await prisma.securityWatchlist.findUnique({
      where: { value },
      select: { id: true, type: true, value: true, reason: true, createdAt: true },
    })

    return NextResponse.json({ match: Boolean(entry), entry })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/security-watchlist/check error')
    return NextResponse.json({ error: 'Failed to check security watchlist' }, { status: 500 })
  }
}

