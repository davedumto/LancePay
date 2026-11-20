import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import bcrypt from 'bcrypt'

// POST /api/routes-d/auth/password/change — change the authenticated user's password

const BCRYPT_ROUNDS = 12
const MIN_PASSWORD_LENGTH = 8

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return (prisma as any).user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, passwordHash: true },
  })
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as {
      currentPassword?: string
      newPassword?: string
    } | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { currentPassword, newPassword } = body

    if (!currentPassword || typeof currentPassword !== 'string') {
      return NextResponse.json({ error: 'currentPassword is required' }, { status: 400 })
    }

    if (!newPassword || typeof newPassword !== 'string') {
      return NextResponse.json({ error: 'newPassword is required' }, { status: 400 })
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 },
      )
    }

    if (currentPassword === newPassword) {
      return NextResponse.json(
        { error: 'newPassword must differ from currentPassword' },
        { status: 400 },
      )
    }

    const passwordHash = (user as Record<string, unknown>).passwordHash as string | null
    if (!passwordHash) {
      return NextResponse.json(
        { error: 'Password login is not enabled for this account' },
        { status: 422 },
      )
    }

    const valid = await bcrypt.compare(currentPassword, passwordHash)
    if (!valid) {
      return NextResponse.json({ error: 'currentPassword is incorrect' }, { status: 403 })
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)

    await (prisma as any).user.update({
      where: { id: user.id },
      data: { passwordHash: newHash } as Record<string, unknown>,
    })

    logger.info({ userId: user.id }, 'POST /api/routes-d/auth/password/change succeeded')

    return NextResponse.json({ message: 'Password changed successfully' })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/auth/password/change error')
    return NextResponse.json({ error: 'Failed to change password' }, { status: 500 })
  }
}
