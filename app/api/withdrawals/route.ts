import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import speakeasy from 'speakeasy'
import { decrypt } from '@/lib/crypto'
import { nanoid } from 'nanoid'

import { initiateOfframp } from '@/lib/offramp'

// In a real production scenario, the backend would need a way to sign the Stellar transaction.
// This could be via a treasury/escrow wallet that has authorization to "pull" funds,
// or by having the frontend pass a signed transaction XDR. 
// For now, we will add a placeholder for this deduction logic as per requirements.
async function deductStellarUSDC(userAddress: string, amount: number, reference: string) {
  // TODO: Implement actual Stellar transaction logic.
  // This requires the sender's secret key or a pre-authorized delegation.
  console.log(`Deducting ${amount} USDC from ${userAddress} for ${reference}`)
  
  // Example of what a real call might look like if we had the keys:
  // await sendUSDCPayment(userAddress, userSecretKey, LANCEPAY_RECEIVER_ADDRESS, amount.toString(), reference)
  
  return { success: true, txHash: 'stub_tx_hash' }
}

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

  const withdrawals = await prisma.transaction.findMany({
    where: { userId: user.id, type: 'withdrawal' },
    include: { bankAccount: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return NextResponse.json({ withdrawals })
}

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    include: { wallet: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { amount, bankAccountId, code } = await request.json()

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
  }

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

  const bankAccount = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, userId: user.id },
  })
  if (!bankAccount) {
    return NextResponse.json({ error: 'Invalid bank account' }, { status: 400 })
  }

  if (!user.wallet) {
    return NextResponse.json({ error: 'Wallet required' }, { status: 400 })
  }

  const { getAccountBalance } = await import('@/lib/stellar')
  const balances = await getAccountBalance(user.wallet.address)
  const usdcBalanceObj = (balances as any[]).find((b: any) => b.asset_code === 'USDC')
  const currentBalance = usdcBalanceObj ? parseFloat(usdcBalanceObj.balance) : 0

  if (currentBalance < amount) {
    return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 })
  }

  const reference = `wd_${nanoid(10)}`

  // 1. Deduct USDC from Stellar wallet before calling the API
  try {
    await deductStellarUSDC(user.wallet.address, amount, reference)
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to deduct funds from Stellar wallet' },
      { status: 400 },
    )
  }

  let offrampResponse
  try {
    offrampResponse = await initiateOfframp({
      amount,
      reference,
      bankAccount: {
        accountNumber: bankAccount.accountNumber,
        bankCode: bankAccount.bankCode,
        accountName: bankAccount.accountName,
      },
    })
  } catch (error: any) {
    // If offramp fails, we should ideally refund the Stellar deduction or log for resolution
    console.error('Off-ramp initiation failed:', error)
    return NextResponse.json(
      { error: error.message || 'Withdrawal provider error' },
      { status: 500 },
    )
  }

  const transaction = await prisma.transaction.create({
    data: {
      userId: user.id,
      type: 'withdrawal',
      status: 'pending',
      amount,
      currency: 'USDC',
      bankAccountId,
      externalId: offrampResponse.transactionId,
    },
  })

  return NextResponse.json(
    {
      message: 'Withdrawal initiated',
      transactionId: transaction.id,
      status: transaction.status,
    },
    { status: 201 },
  )
}
