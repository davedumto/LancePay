import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── DELETE /api/routes-d/auth/2fa — disable two-factor authentication ──
//
// Disables 2FA for the authenticated user. Returns 409 if 2FA is already
// disabled so the client can surface the state without triggering a
// misleading success.

export async function DELETE(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (!user.twoFactorEnabled) {
      return NextResponse.json(
        { error: '2FA is already disabled' },
        { status: 409 },
      )
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
      },
    })

    return NextResponse.json({
      twoFactor: {
        enabled: false,
        disabledAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, '2fa disable error')
    return NextResponse.json(
      { error: 'Failed to disable two-factor authentication' },
      { status: 500 },
    )
  }
}
