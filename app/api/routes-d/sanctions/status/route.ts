import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

type SanctionsScreeningDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

function getSanctionsDelegate(): SanctionsScreeningDelegate {
  return (prisma as unknown as { sanctionsScreening: SanctionsScreeningDelegate }).sanctionsScreening
}

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
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sanctionsDelegate = getSanctionsDelegate()
  const record = await sanctionsDelegate.findUnique({
    where: { userId: user.id },
    select: {
      status: true,
      provider: true,
      matchScore: true,
      screenedAt: true,
      expiresAt: true,
    },
  })

  // No screening has been performed yet: callers can render an
  // "Awaiting screening" state without having to differentiate 404 vs 200.
  if (!record) {
    return NextResponse.json({
      status: 'unscreened',
      provider: null,
      matchScore: null,
      screenedAt: null,
      expiresAt: null,
    })
  }

  return NextResponse.json({
    status: record.status,
    provider: record.provider,
    matchScore: record.matchScore ?? null,
    screenedAt: record.screenedAt,
    expiresAt: record.expiresAt ?? null,
  })
}
