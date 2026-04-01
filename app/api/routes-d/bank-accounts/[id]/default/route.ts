import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const bankAccount = await prisma.bankAccount.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      isDefault: true,
      bankName: true,
      accountNumber: true,
    },
  })

  if (!bankAccount) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
  }

  if (bankAccount.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (bankAccount.isDefault) {
    return NextResponse.json(
      {
        id: bankAccount.id,
        isDefault: true,
        bankName: bankAccount.bankName,
        accountNumber: bankAccount.accountNumber,
      },
      { status: 200 },
    )
  }

  const [, updatedBankAccount] = await prisma.$transaction([
    prisma.bankAccount.updateMany({
      where: { userId: user.id, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.bankAccount.update({
      where: { id },
      data: { isDefault: true },
      select: {
        id: true,
        isDefault: true,
        bankName: true,
        accountNumber: true,
      },
    }),
  ])

  return NextResponse.json(updatedBankAccount, { status: 200 })
}
