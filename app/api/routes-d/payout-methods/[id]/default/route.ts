import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    const method = await prisma.paymentMethod.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        type: true,
        name: true,
        value: true,
        isDefault: true,
      },
    })

    if (!method) {
      return NextResponse.json({ error: 'Payout method not found' }, { status: 404 })
    }

    if (method.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (method.isDefault) {
      return NextResponse.json(
        {
          payoutMethod: {
            id: method.id,
            type: method.type,
            name: method.name,
            value: method.value,
            isDefault: true,
          },
        },
        { status: 200 },
      )
    }

    const [, updatedMethod] = await prisma.$transaction([
      prisma.paymentMethod.updateMany({
        where: { userId: user.id, isDefault: true },
        data: { isDefault: false },
      }),
      prisma.paymentMethod.update({
        where: { id },
        data: { isDefault: true },
        select: {
          id: true,
          type: true,
          name: true,
          value: true,
          isDefault: true,
        },
      }),
    ])

    return NextResponse.json({ payoutMethod: updatedMethod }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'Routes D payout-methods default PATCH error')
    return NextResponse.json({ error: 'Failed to update payout method default' }, { status: 500 })
  }
}
