import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    const { id } = await context.params

    const apiKey = await prisma.apiKey.findFirst({
      where: { id, userId: user.id },
      select: { id: true, revoked: true },
    })
    if (!apiKey) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 })
    }
    if (apiKey.revoked) {
      return NextResponse.json({ error: 'API key already revoked' }, { status: 409 })
    }

    await prisma.apiKey.update({
      where: { id },
      data: { revoked: true, revokedAt: new Date() },
    })

    logger.info({ userId: user.id, apiKeyId: id }, 'API key revoked')

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api-keys/[id] error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
