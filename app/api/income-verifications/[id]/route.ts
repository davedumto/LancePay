import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// DELETE /api/income-verifications/[id] — revoke an income verification link early.
// Only the user who created the verification link can revoke it.
// Returns 404 if the link was already expired or previously revoked.
// Revocation takes effect immediately because the record is hard-deleted from the database,
// causing any subsequent view attempt at /api/income-verifications/[token]/view to fail with 404.

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
      'DELETE /api/income-verifications/[id]',
    )
    return NextResponse.json({ id, revoked: true }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/income-verifications/[id] error')
    return NextResponse.json({ error: 'Failed to delete income verification' }, { status: 500 })
  }
}
