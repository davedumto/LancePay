import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

async function getAuthenticatedUserId(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })

  return user?.id ?? null
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getAuthenticatedUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const bankAccount = await prisma.bankAccount.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      isDefault: true,
    },
  })

  if (!bankAccount) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
  }

  if (bankAccount.userId !== userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await prisma.$transaction(async (tx) => {
    if (bankAccount.isDefault) {
      const nextDefault = await tx.bankAccount.findFirst({
        where: {
          userId,
          id: { not: id },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })

      if (nextDefault) {
        await tx.bankAccount.update({
          where: { id: nextDefault.id },
          data: { isDefault: true },
        })
      }
    }

    await tx.bankAccount.delete({
      where: { id },
    })
  })

  return new NextResponse(null, { status: 204 })
}
