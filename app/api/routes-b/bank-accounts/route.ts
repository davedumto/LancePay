import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { validateIBAN } from '../_lib/iban'
import { validateSWIFT } from '../_lib/swift'
import { bankAccountDisplayName } from '../_lib/bank-accounts'

function isValidDigits(value: string, min: number, max: number) {
  const pattern = new RegExp(`^\\d{${min},${max}}$`)
  return pattern.test(value)
}

/** Lists the authenticated user's saved bank accounts (default account first). */
async function GETHandler(request: NextRequest) {
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
      nickname: true,
      createdAt: true,
    },
  })

  return NextResponse.json({
    bankAccounts: bankAccounts.map(a => ({
      ...a,
      displayName: bankAccountDisplayName(a),
    })),
  })
}

async function POSTHandler(request: NextRequest) {
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
  const { bankName, bankCode, accountNumber, accountName, iban, swift, nickname } = body ?? {}

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

  if (iban !== undefined && (typeof iban !== 'string' || !validateIBAN(iban))) {
    return NextResponse.json({ error: 'Invalid IBAN format' }, { status: 400 })
  }

  if (swift !== undefined && (typeof swift !== 'string' || !validateSWIFT(swift))) {
    return NextResponse.json({ error: 'Invalid SWIFT/BIC format' }, { status: 400 })
  }

  if (nickname !== undefined && nickname !== '' && (typeof nickname !== 'string' || nickname.trim().length > 32)) {
    return NextResponse.json({ error: 'nickname must be a string of at most 32 characters' }, { status: 400 })
  }

  const existing = await prisma.bankAccount.findFirst({
    where: {
      userId: user.id,
      accountNumber: { equals: accountNumber, mode: 'insensitive' },
      bankCode: { equals: bankCode, mode: 'insensitive' },
    },
  })

  if (existing) {
    return NextResponse.json(
      { error: 'Bank account already exists', existingId: existing.id },
      { status: 409 },
    )
  }

  const existingCount = await prisma.bankAccount.count({ where: { userId: user.id } })
  const isDefault = existingCount === 0

  const resolvedNickname =
    typeof nickname === 'string' && nickname.trim() !== '' ? nickname.trim() : null

  const bankAccount = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      bankName: bankName.trim(),
      bankCode,
      accountNumber,
      accountName: accountName.trim(),
      isDefault,
      nickname: resolvedNickname,
    },
    select: {
      id: true,
      bankName: true,
      bankCode: true,
      accountNumber: true,
      accountName: true,
      isDefault: true,
      nickname: true,
      createdAt: true,
    },
  })

  return NextResponse.json(
    { ...bankAccount, displayName: bankAccountDisplayName(bankAccount) },
    { status: 201 },
  )
}

export const GET = withRequestId(GETHandler)
export const POST = withRequestId(POSTHandler)
