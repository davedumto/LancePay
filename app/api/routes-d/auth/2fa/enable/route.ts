import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (user.twoFactorEnabled) {
      return NextResponse.json({ error: '2FA is already enabled' }, { status: 409 })
    }

    const secret = crypto.randomBytes(20).toString('hex').toUpperCase()

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorSecret: secret,
        twoFactorEnabled: true,
      },
    })

    return NextResponse.json({
      twoFactor: {
        secret,
        enabled: true,
        enabledAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, '2fa enable error')
    return NextResponse.json({ error: 'Failed to enable two-factor authentication' }, { status: 500 })
  }
}
