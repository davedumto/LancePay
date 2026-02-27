import { NextRequest, NextResponse } from 'next/server'
import { verifyNigerianBankAccount } from '@/lib/bank-verification'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

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

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Parse request body
    const { accountNumber, bankCode } = await request.json()

    // Validate required fields
    if (!accountNumber || !bankCode) {
      return NextResponse.json(
        { error: 'Account number and bank code are required' },
        { status: 400 }
      )
    }

    // Validate account number format
    if (accountNumber.length !== 10 || !/^\d{10}$/.test(accountNumber)) {
      return NextResponse.json(
        { error: 'Invalid account number - must be 10 digits' },
        { status: 400 }
      )
    }
    const bankName = BANKS[bankCode]
    if (!bankName) {
      return NextResponse.json(
        { error: 'Invalid bank code' },
        { status: 400 }
      )
    }
    const verification = await verifyNigerianBankAccount(accountNumber, bankCode)

    if (!verification.valid) {
      return NextResponse.json(
        {
          error: verification.error || 'Account verification failed',
          details: 'Please check your account number and bank code',
        },
        { status: 400 }
      )
    }
    const existingAccount = await prisma.bankAccount.findFirst({
      where: {
        userId: user.id,
        accountNumber: accountNumber,
      },
    })

    if (existingAccount) {
      return NextResponse.json(
        { error: 'This bank account is already added to your profile' },
        { status: 409 }
      )
    }

    // Determine if this is the first account (set as default)
    const isFirst = (await prisma.bankAccount.count({ where: { userId: user.id } })) === 0
    const bankAccount = await prisma.bankAccount.create({
      data: {
        userId: user.id,
        accountNumber: verification.accountNumber!,
        accountName: verification.accountName!, 
        bankName: bankName,
        bankCode: bankCode,
        isVerified: true,
        isDefault: isFirst,
      },
    })

    return NextResponse.json(
      {
        success: true,
        message: 'Bank account verified and added successfully',
        bankAccount: {
          id: bankAccount.id,
          accountNumber: bankAccount.accountNumber,
          accountName: bankAccount.accountName,
          bankName: bankAccount.bankName,
          bankCode: bankAccount.bankCode,
          isVerified: bankAccount.isVerified,
          isDefault: bankAccount.isDefault,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Error adding bank account:')

    // Handle Prisma unique constraint errors
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      return NextResponse.json(
        { error: 'This bank account already exists' },
        { status: 409 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to add bank account. Please try again.' },
      { status: 500 }
    )
  }
}