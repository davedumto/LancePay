import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import speakeasy from 'speakeasy'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, twoFactorSecret: true, twoFactorEnabled: true },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      return NextResponse.json({ error: '2FA is not enabled' }, { status: 400 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const code = (body as Record<string, unknown>).code
    if (typeof code !== 'string') {
      return NextResponse.json({ error: 'code must be a string' }, { status: 400 })
    }

    const verified = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: code,
      window: 2,
    })

    if (!verified) {
      return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/auth/2fa/verify error')
    return NextResponse.json({ error: 'Failed to verify 2FA code' }, { status: 500 })
  }
}
