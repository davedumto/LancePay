import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import bcrypt from 'bcryptjs'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json()
    const { token, newPassword } = body

    if (!token || typeof token !== 'string' || token.trim() === '') {
      return NextResponse.json({ error: 'Reset token is required' }, { status: 400 })
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return NextResponse.json({ error: 'newPassword must be at least 8 characters' }, { status: 400 })
    }

    const resetRequest = await (prisma as any).passwordResetToken.findFirst({
      where: {
        userId: user.id,
        token: token.trim(),
        expiresAt: { gt: new Date() },
        used: false,
      },
    })

    if (!resetRequest) {
      return NextResponse.json({ error: 'Invalid or expired reset token' }, { status: 400 })
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12)

    await prisma.$transaction([
      (prisma as any).passwordResetToken.update({
        where: { id: resetRequest.id },
        data: { used: true },
      }),
      (prisma as any).user.update({
        where: { id: user.id },
        data: { passwordHash: hashedPassword },
      }),
    ])

    return NextResponse.json({ message: 'Password reset successfully' })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/auth/password/reset-confirm error')
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 })
  }
}
