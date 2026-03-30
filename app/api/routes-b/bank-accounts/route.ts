import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function isValidDigits(value: string, min: number, max: number) {
  const pattern = new RegExp(`^\\d{${min},${max}}$`)
  return pattern.test(value)
}

/** Lists the authenticated user's saved bank accounts (default account first). */
export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const bankAccounts = await prisma.bankAccount.findMany({
    where: { userId: user.id },
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

  return NextResponse.json({ bankAccounts })
}

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const body = await request.json()
  const { bankName, bankCode, accountNumber, accountName } = body ?? {}

  if (
    typeof bankName !== 'string' ||
    bankName.trim() === '' ||
    bankName.trim().length > 100 ||
    typeof bankCode !== 'string' ||
    !isValidDigits(bankCode, 3, 10) ||
    typeof accountNumber !== 'string' ||
    !/^\d{10}$/.test(accountNumber) ||
    typeof accountName !== 'string' ||
    accountName.trim() === '' ||
    accountName.trim().length > 100
  ) {
    return NextResponse.json(
      {
        error:
          'Invalid input. bankName/accountName must be non-empty <= 100 chars, bankCode must be 3-10 digits, and accountNumber must be exactly 10 digits.',
      },
      { status: 400 },
    )
  }

  const existingCount = await prisma.bankAccount.count({ where: { userId: user.id } })
  const isDefault = existingCount === 0

  const bankAccount = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      bankName: bankName.trim(),
      bankCode,
      accountNumber,
      accountName: accountName.trim(),
      isDefault,
    },
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

  return NextResponse.json(bankAccount, { status: 201 })
}
