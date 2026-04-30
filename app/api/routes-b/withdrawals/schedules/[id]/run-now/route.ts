import { withRequestId } from '../../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getSchedule } from '../../../../_lib/withdrawal-scheduler'
import { calculateWithdrawalFee } from '../../../../_lib/withdrawal-fees'

async function fetchWalletBalance(address: string): Promise<number | null> {
  const statusUrl = process.env.CHAIN_RPC_WALLET_BALANCE_URL
  if (!statusUrl) return null

  const response = await fetch(statusUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
    cache: 'no-store',
  })

  if (!response.ok) throw new Error('Upstream failed')
  const payload: any = await response.json()
  const balance = Number(payload.balance)
  if (!Number.isFinite(balance)) throw new Error('Invalid balance schema')
  return balance
}

async function POSTHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const schedule = getSchedule(id)
  if (!schedule || schedule.userId !== user.id) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 400 })

  let balance = 0
  try {
    const fetched = await fetchWalletBalance(wallet.address)
    balance = fetched ?? 0
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch balance' }, { status: 500 })
  }

  let amountToWithdraw = 0
  if (schedule.percentOrAmount.type === 'percent') {
    amountToWithdraw = balance * (schedule.percentOrAmount.value / 100)
  } else {
    amountToWithdraw = schedule.percentOrAmount.value
  }

  if (amountToWithdraw < 1) {
    return NextResponse.json({ error: 'Withdrawal amount too small' }, { status: 400 })
  }

  if (amountToWithdraw > balance) {
    return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 })
  }

  const { fee, netAmount } = calculateWithdrawalFee(amountToWithdraw, 'USDC')

  const transaction = await prisma.transaction.create({
    data: {
      userId: user.id,
      type: 'withdrawal',
      status: 'pending',
      amount: netAmount,
      currency: 'USDC',
      bankAccountId: schedule.bankId,
    },
    select: {
      id: true,
      type: true,
      status: true,
      amount: true,
      currency: true,
      createdAt: true,
    },
  })

  return NextResponse.json({
    ...transaction,
    amount: Number(transaction.amount),
    fee,
  }, { status: 201 })
}

export const POST = withRequestId(POSTHandler)
