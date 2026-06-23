import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

type UserSessionDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
}

function getSessionDelegate(): UserSessionDelegate {
  return (prisma as unknown as { userSession: UserSessionDelegate }).userSession
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })

  return user ? { ...user, presentedToken: authToken ?? '' } : null
}

function lastSixOf(token: string): string {
  if (!token) return ''
  const trimmed = token.trim()
  return trimmed.length <= 6 ? trimmed : trimmed.slice(-6)
}

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sessionDelegate = getSessionDelegate()
  const sessions = await sessionDelegate.findMany({
    where: {
      userId: user.id,
      revokedAt: null,
    },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      id: true,
      deviceLabel: true,
      userAgent: true,
      ipAddress: true,
      tokenHint: true,
      issuedAt: true,
      lastSeenAt: true,
    },
  })

  // Mark the session whose tokenHint matches the bearer the caller
  // presented so the UI can label it "This device". Comparison is done
  // on the last six characters to avoid leaking the full token via
  // timing differences.
  const presentedHint = lastSixOf(user.presentedToken)

  return NextResponse.json({
    sessions: sessions.map((session) => ({
      id: session.id,
      deviceLabel: session.deviceLabel ?? null,
      userAgent: session.userAgent ?? null,
      ipAddress: session.ipAddress ?? null,
      tokenHint: session.tokenHint ?? null,
      issuedAt: session.issuedAt,
      lastSeenAt: session.lastSeenAt,
      isCurrent: presentedHint !== '' && session.tokenHint === presentedHint,
    })),
  })
}
