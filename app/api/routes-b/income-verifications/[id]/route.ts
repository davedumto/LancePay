import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// DELETE /api/routes-b/income-verifications/[id] — revoke an income verification link.
// Only the user who created the verification link can revoke it.
// Revocation takes effect immediately — any in-flight view attempt will fail
// because the record is hard-deleted from the database and subsequent lookups return null.

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const verification = await prisma.incomeVerification.findUnique({
      where: { id },
      select: { id: true, userId: true, expiresAt: true },
    })

    if (!verification) {
      return NextResponse.json({ error: 'Income verification not found' }, { status: 404 })
    }
    if (verification.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (verification.expiresAt <= new Date()) {
      return NextResponse.json({ error: 'Income verification not found' }, { status: 404 })
    }

    await prisma.incomeVerification.delete({ where: { id } })

    logger.info(
      { userId: user.id, verificationId: id },
      'DELETE /api/routes-b/income-verifications/[id]',
    )
    return NextResponse.json({ id }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-b/income-verifications/[id] error')
    return NextResponse.json({ error: 'Failed to delete income verification' }, { status: 500 })
  }
}
