import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const account = await prisma.bankAccount.findUnique({ where: { id } })
  if (!account) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
  }

  if (account.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (account.isDefault) {
    const next = await prisma.bankAccount.findFirst({
      where: { userId: user.id, id: { not: id } },
      orderBy: { createdAt: 'asc' },
    })

    if (next) {
      await prisma.bankAccount.update({
        where: { id: next.id },
        data: { isDefault: true },
      })
    }
  }

  await prisma.bankAccount.delete({ where: { id } })

  return new NextResponse(null, { status: 204 })
}
