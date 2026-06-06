import crypto from 'node:crypto'

import { withRequestId } from '../_lib/with-request-id'
import { withMethods } from '../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { validateIBAN } from '../_lib/iban'
import { validateSWIFT } from '../_lib/swift'
import { bankAccountDisplayName } from '../_lib/bank-accounts'
import { normalizeString } from '../_lib/normalize'

import {
  getIdempotentResponse,
  setIdempotentResponse,
} from '../_lib/idempotency'

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

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

  const idempotencyKey = request.headers.get('idempotency-key')
  const bodyHash = idempotencyKey ? crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') : ''

  if (idempotencyKey) {
    const cached = getIdempotentResponse(idempotencyKey)

    if (cached) {
      if (cached.bodyHash !== bodyHash) {
        return NextResponse.json(
          { error: 'Idempotency-Key conflict' },
          { status: 409 }
        )
      }

      return NextResponse.json(
        cached.body,
        { status: cached.status }
      )
    }
  }
  const normalizedBankName = typeof bankName === 'string' ? normalizeString(bankName) : ''
  const normalizedAccountName = typeof accountName === 'string' ? normalizeString(accountName) : ''

  if (
    !normalizedBankName ||
    normalizedBankName.length > 100 ||
    typeof bankCode !== 'string' ||
    !isValidDigits(bankCode, 3, 10) ||
    typeof accountNumber !== 'string' ||
    !/^\d{10}$/.test(accountNumber) ||
    !normalizedAccountName ||
    normalizedAccountName.length > 100
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

  let normalizedNickname: string | undefined
  if (nickname !== undefined) {
    if (typeof nickname !== 'string') {
      return NextResponse.json({ error: 'nickname must be a string of at most 32 characters' }, { status: 400 })
    }
    normalizedNickname = normalizeString(nickname)
    if (normalizedNickname && normalizedNickname.length > 32) {
      return NextResponse.json({ error: 'nickname must be a string of at most 32 characters' }, { status: 400 })
    }
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

  const bankAccount = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      bankName: normalizedBankName,
      bankCode,
      accountNumber,
      accountName: normalizedAccountName,
      isDefault,
      nickname: normalizedNickname || null,
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

  const responseBody = { ...bankAccount, displayName: bankAccountDisplayName(bankAccount) }

  if (idempotencyKey) {
    setIdempotentResponse(
      idempotencyKey,
      {
        bodyHash,
        status: 201,
        body: responseBody,
      },
      IDEMPOTENCY_TTL_MS
    )
  }

  return NextResponse.json(
    responseBody,
    { status: 201 },
  )
}

export const { GET, POST } = withMethods({
  GET: withRequestId(GETHandler),
  POST: withRequestId(POSTHandler),
})