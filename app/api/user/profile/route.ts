import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import speakeasy from 'speakeasy'
import { decrypt } from '@/lib/crypto'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // First try to find existing user
    let user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, email: true, name: true, phone: true, taxPercentage: true, createdAt: true },
    })

    // If not found, create with a unique email
    if (!user) {
      const email = (claims as any).email || `${claims.userId}@privy.local`
      user = await prisma.user.create({
        data: {
          privyId: claims.userId,
          email: email,
        },
        select: { id: true, email: true, name: true, phone: true, taxPercentage: true, createdAt: true },
      })
    }

    return NextResponse.json(user)
  } catch (error) {
    logger.error({ err: error }, 'Profile GET error:')
    return NextResponse.json({ error: 'Failed to get profile' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { name, phone, taxPercentage, code } = await request.json()

    // First try to find existing user
    let user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    // 2FA Check for updates
    if (user?.twoFactorEnabled) {
      if (!code) {
        return NextResponse.json({ error: '2FA code required' }, { status: 401 })
      }
      if (user.twoFactorSecret) {
        const secret = decrypt(user.twoFactorSecret)
        const verified = speakeasy.totp.verify({
          secret: secret,
          encoding: 'base32',
          token: code,
          window: 1
        })
        if (!verified) {
          return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 })
        }
      }
    }

    const taxPct = taxPercentage !== undefined ? Number(taxPercentage) : undefined
    if (taxPct !== undefined && (taxPct < 0 || taxPct > 100)) {
      return NextResponse.json({ error: 'taxPercentage must be between 0 and 100' }, { status: 400 })
    }

    if (user) {
      // Update existing user
      user = await prisma.user.update({
        where: { privyId: claims.userId },
        data: {
          name,
          phone,
          ...(taxPct !== undefined && { taxPercentage: taxPct }),
        },
      })
    } else {
      // Create new user
      const email = (claims as any).email || `${claims.userId}@privy.local`
      user = await prisma.user.create({
        data: {
          privyId: claims.userId,
          email: email,
          name,
          phone,
          ...(taxPct !== undefined && { taxPercentage: taxPct }),
        },
      })
    }

    return NextResponse.json(user)
  } catch (error) {
    logger.error({ err: error }, 'Profile PUT error:')
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
  }
}
