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

function maskAccountNumber(accountNumber: string) {
  if (accountNumber.length <= 4) {
    return accountNumber
  }

  return `${'*'.repeat(Math.max(0, accountNumber.length - 4))}${accountNumber.slice(-4)}`
}

export async function GET(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const bankAccounts = await prisma.bankAccount.findMany({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      bankName: true,
      bankCode: true,
      accountNumber: true,
      accountName: true,
      isDefault: true,
      createdAt: true,
    },
  })

  return NextResponse.json({
    bankAccounts: bankAccounts.map((bankAccount: (typeof bankAccounts)[number]) => ({
      ...bankAccount,
      accountNumber: maskAccountNumber(bankAccount.accountNumber),
    })),
  })
}
