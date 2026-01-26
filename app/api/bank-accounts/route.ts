import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { verifyNigerianBankAccount } from '@/lib/bank-verification'
import speakeasy from 'speakeasy'
import { decrypt } from '@/lib/crypto'

const BANKS: Record<string, string> = {
  '044': 'Access Bank',
  '063': 'Access Bank (Diamond)',
  '050': 'Ecobank Nigeria',
  '070': 'Fidelity Bank',
  '011': 'First Bank of Nigeria',
  '214': 'First City Monument Bank',
  '058': 'Guaranty Trust Bank',
  '030': 'Heritage Bank',
  '301': 'Jaiz Bank',
  '082': 'Keystone Bank',
  '526': 'Parallex Bank',
  '076': 'Polaris Bank',
  '101': 'Providus Bank',
  '221': 'Stanbic IBTC Bank',
  '068': 'Standard Chartered Bank',
  '232': 'Sterling Bank',
  '100': 'Suntrust Bank',
  '032': 'Union Bank of Nigeria',
  '033': 'United Bank For Africa',
  '215': 'Unity Bank',
  '035': 'Wema Bank',
  '057': 'Zenith Bank',
}

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const bankAccounts = await prisma.bankAccount.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ bankAccounts, banks: BANKS })
}

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { bankCode, accountNumber, code } = await request.json()

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

  if (!bankCode || !accountNumber || accountNumber.length !== 10) {
    return NextResponse.json(
      { error: 'Invalid input - account number must be 10 digits' },
      { status: 400 }
    )
  }

  const bankName = BANKS[bankCode]
  if (!bankName) {
    return NextResponse.json({ error: 'Invalid bank code' }, { status: 400 })
  }

  const verification = await verifyNigerianBankAccount(accountNumber, bankCode)

  if (!verification.valid) {
    return NextResponse.json(
      {
        error: verification.error || 'Account verification failed',
        details: 'Please verify your account number and bank are correct',
      },
      { status: 400 }
    )
  }

  // Check for existing account
  const existing = await prisma.bankAccount.findFirst({
    where: { userId: user.id, accountNumber },
  })

  if (existing) {
    return NextResponse.json(
      { error: 'This bank account is already linked to your profile' },
      { status: 409 }
    )
  }

  const isFirst = (await prisma.bankAccount.count({ where: { userId: user.id } })) === 0

  const bankAccount = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      bankCode,
      bankName,
      accountNumber: verification.accountNumber!,
      accountName: verification.accountName!, 
      isVerified: true,
      isDefault: isFirst,
    },
  })

  return NextResponse.json(bankAccount, { status: 201 })
}
