import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { calculateWithdrawalFee } from '../_lib/withdrawal-fees'

/**
 * GET /api/routes-b/withdrawals
 * List withdrawal history for the authenticated user.
 */
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

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(searchParams.get('limit') || '20', 10) || 20))

  const where = { userId: user.id, type: 'withdrawal' }
  const [total, transactions] = await Promise.all([
    prisma.transaction.count({ where }),
    prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        createdAt: true,
      },
    }),
  ])

  return NextResponse.json({
    withdrawals: transactions.map((t) => ({
      ...t,
      amount: Number(t.amount),
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
}

/**
 * POST /api/routes-b/withdrawals
 * Record a new withdrawal request against a user's bank account.
 */
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

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { amount, bankAccountId } = body

  // Validation rules: amount required, positive number, minimum 1
  if (
    amount === undefined ||
    amount === null ||
    typeof amount !== 'number' ||
    amount < 1
  ) {
    return NextResponse.json(
      { error: 'amount is required and must be a positive number (minimum 1)' },
      { status: 400 },
    )
  }

  // Validation rules: bankAccountId required
  if (!bankAccountId || typeof bankAccountId !== 'string') {
    return NextResponse.json({ error: 'bankAccountId is required' }, { status: 400 })
  }

  // Find BankAccount by bankAccountId — verify it belongs to user.id; if not -> 403
  const bankAccount = await prisma.bankAccount.findFirst({
    where: {
      id: bankAccountId,
      userId: user.id,
    },
  })

  if (!bankAccount) {
    return NextResponse.json(
      { error: 'Bank account not found or does not belong to the user' },
      { status: 403 },
    )
  }

  // Apply fee logic (same as estimate endpoint)
  const { fee, netAmount } = calculateWithdrawalFee(amount, 'USDC')

  // Create a Transaction record: type: 'withdrawal', status: 'pending', amount, userId: user.id
  const transaction = await prisma.transaction.create({
    data: {
      userId: user.id,
      type: 'withdrawal',
      status: 'pending',
      amount: netAmount,
      currency: 'USDC',
      bankAccountId,
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

  // Return the created transaction (201 Created)
  return NextResponse.json(
    {
      ...transaction,
      amount: Number(transaction.amount),
      fee,
    },
    { status: 201 },
  )
}
