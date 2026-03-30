import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const MAX_BANK_NAME_LENGTH = 100
const MAX_ACCOUNT_NAME_LENGTH = 100
const BANK_CODE_PATTERN = /^\d{3,10}$/
const ACCOUNT_NUMBER_PATTERN = /^\d{10}$/

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

type CreateBankAccountBody = {
  bankName?: unknown
  bankCode?: unknown
  accountNumber?: unknown
  accountName?: unknown
  isDefault?: unknown
}

function parseRequiredString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string') {
    return `${field} is required`
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return `${field} is required`
  }

  if (trimmed.length > maxLength) {
    return `${field} must be at most ${maxLength} characters`
  }

  return trimmed
}

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: CreateBankAccountBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const bankName = parseRequiredString(body.bankName, 'bankName', MAX_BANK_NAME_LENGTH)
  if (typeof bankName !== 'string') {
    return NextResponse.json({ error: bankName }, { status: 400 })
  }

  const bankCode = parseRequiredString(body.bankCode, 'bankCode', 10)
  if (typeof bankCode !== 'string') {
    return NextResponse.json({ error: bankCode }, { status: 400 })
  }

  if (!BANK_CODE_PATTERN.test(bankCode)) {
    return NextResponse.json(
      { error: 'bankCode must be a string of 3 to 10 digits' },
      { status: 400 },
    )
  }

  const accountNumber = parseRequiredString(body.accountNumber, 'accountNumber', 10)
  if (typeof accountNumber !== 'string') {
    return NextResponse.json({ error: accountNumber }, { status: 400 })
  }

  if (!ACCOUNT_NUMBER_PATTERN.test(accountNumber)) {
    return NextResponse.json(
      { error: 'accountNumber must be a string of 10 digits' },
      { status: 400 },
    )
  }

  const accountName = parseRequiredString(
    body.accountName,
    'accountName',
    MAX_ACCOUNT_NAME_LENGTH,
  )
  if (typeof accountName !== 'string') {
    return NextResponse.json({ error: accountName }, { status: 400 })
  }

  if (body.isDefault !== undefined && typeof body.isDefault !== 'boolean') {
    return NextResponse.json({ error: 'isDefault must be a boolean' }, { status: 400 })
  }

  const existingAccountCount = await prisma.bankAccount.count({
    where: { userId },
  })

  const isFirstAccount = existingAccountCount === 0
  const shouldBeDefault = isFirstAccount || body.isDefault === true

  if (body.isDefault === true) {
    await prisma.bankAccount.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    })
  }

  const bankAccount = await prisma.bankAccount.create({
    data: {
      userId,
      bankName,
      bankCode,
      accountNumber,
      accountName,
      isDefault: shouldBeDefault,
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

  return NextResponse.json(
    {
      id: bankAccount.id,
      bankName: bankAccount.bankName,
      bankCode: bankAccount.bankCode,
      accountNumber: bankAccount.accountNumber,
      accountName: bankAccount.accountName,
      isDefault: bankAccount.isDefault,
      createdAt: bankAccount.createdAt,
    },
    { status: 201 },
  )
}
