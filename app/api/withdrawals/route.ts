import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import speakeasy from 'speakeasy'
import { decrypt } from '@/lib/crypto'

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const withdrawals = await prisma.transaction.findMany({
    where: { userId: user.id, type: 'withdrawal' },
    include: { bankAccount: true },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({ withdrawals })
}

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

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

  const exchangeRate = 1600
  const ngnAmount = amount * exchangeRate

  const withdrawal = await prisma.transaction.create({
    data: { userId: user.id, type: 'withdrawal', status: 'completed', amount, currency: 'USD', ngnAmount, exchangeRate, bankAccountId, completedAt: new Date() },
  })

  return NextResponse.json(withdrawal, { status: 201 })
}
