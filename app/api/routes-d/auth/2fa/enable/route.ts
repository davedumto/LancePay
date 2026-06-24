import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function generateBase32Secret(byteLength = 20): string {
  const bytes = crypto.randomBytes(byteLength)
  let result = ''
  let buffer = 0
  let bitsLeft = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bitsLeft += 8
    while (bitsLeft >= 5) {
      bitsLeft -= 5
      result += BASE32_CHARS[(buffer >> bitsLeft) & 0x1f]
    }
  }
  if (bitsLeft > 0) {
    result += BASE32_CHARS[(buffer << (5 - bitsLeft)) & 0x1f]
  }
  return result
}

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

    const secret = generateBase32Secret()

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
