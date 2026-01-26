import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import speakeasy from 'speakeasy'
import { decrypt } from '@/lib/crypto'

import { initiateWithdrawal } from '@/lib/yellowcard'
import { nanoid } from 'nanoid'



export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { amount, bankAccountId, code } = await request.json()

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
  }

  //  2FA Check (unchanged)
  if (user.twoFactorEnabled) {
    if (!code) {
      return NextResponse.json({ error: '2FA code required' }, { status: 401 })
    }
    if (user.twoFactorSecret) {
      const secret = decrypt(user.twoFactorSecret)
      const verified = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token: code,
        window: 1,
      })
      if (!verified) {
        return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 })
      }
    }
  }

  //  Validate bank account
  const bankAccount = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, userId: user.id },
  })
  if (!bankAccount) {
    return NextResponse.json({ error: 'Invalid bank account' }, { status: 400 })
  }

  //  Balance check 
  if (user.usdcBalance < amount) {
    return NextResponse.json(
      { error: 'Insufficient balance' },
      { status: 400 }
    )
  }


  //  Call Yellow Card
  const reference = `wd_${nanoid(10)}`

  const requestBody = await request.json()
  const { amount, bankAccountId, code } = requestBody

  // 2FA Check
  if (user.twoFactorEnabled) {
    if (!code) {
      return NextResponse.json({ error: '2FA code required' }, { status: 401 })
    }
    if (user.twoFactorSecret) {
      const secret = decrypt(user.twoFactorSecret)
      const verified = speakeasy.totp.verify({
        secret: secret,
        encoding: 'base32',
        token: code,
        window: 1
      })
      if (!verified) {
        return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 })
      }
    }
  }

  const bankAccount = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, userId: user.id } })
  if (!bankAccount) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })


  let ycResponse
  try {
    ycResponse = await initiateWithdrawal({
      amount,
      reference,
      bankAccount: {
        accountNumber: bankAccount.accountNumber,
        bankCode: bankAccount.bankCode,
        accountName: bankAccount.accountName,
      },
    })
  } catch {
    return NextResponse.json(
      { error: 'Withdrawal provider error' },
      { status: 500 }
    )
  }

  //  Save as PENDING (NO COMPLETION)
  const transaction = await prisma.transaction.create({
    data: {
      userId: user.id,
      type: 'withdrawal',
      status: 'pending',
      amount,
      currency: 'USDC',
      bankAccountId,
      provider: 'yellowcard',
      externalId: ycResponse.transactionId,
      reference,
    },
  })

  return NextResponse.json(
    {
      message: 'Withdrawal initiated',
      transactionId: transaction.id,
      status: transaction.status,
    },
    { status: 201 }
  )
}
