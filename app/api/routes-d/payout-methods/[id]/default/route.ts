import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    const { id } = params
    if (!id) return NextResponse.json({ error: 'Missing payout method id' }, { status: 400 })

    const method = await prisma.payoutMethod.findFirst({
      where: { id, userId: user.id },
      select: { id: true, isDefault: true },
    })

    if (!method) {
      return NextResponse.json({ error: 'Payout method not found' }, { status: 404 })
    }

    if (method.isDefault) {
      return NextResponse.json({ error: 'Payout method is already the default' }, { status: 409 })
    }

    // Unset current default, set new default atomically
    await prisma.$transaction([
      prisma.payoutMethod.updateMany({
        where: { userId: user.id, isDefault: true },
        data: { isDefault: false },
      }),
      prisma.payoutMethod.update({
        where: { id },
        data: { isDefault: true },
      }),
    ])

    const updated = await prisma.payoutMethod.findUnique({
      where: { id },
      select: { id: true, type: true, label: true, isDefault: true, updatedAt: true },
    })

    logger.info({ userId: user.id, methodId: id }, 'Default payout method updated')

    return NextResponse.json({ payoutMethod: updated })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /payout-methods/[id]/default error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
