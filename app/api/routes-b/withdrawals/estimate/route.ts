/**
 * GET /api/routes-b/withdrawals/estimate
 * Returns a fee estimate for a withdrawal without creating any records.
 *
 * Query params:
 *   amount    - positive number (required)
 *   currency  - e.g. USDC (required)
 *   bankId    - bank account id (required, must belong to user)
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { calculateWithdrawalFee, isSupportedCurrency } from '../../_lib/withdrawal-fees'

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
  const amountParam = searchParams.get('amount')
  const currency = searchParams.get('currency') || ''
  const bankId = searchParams.get('bankId') || ''

  // Validate amount
  const amount = Number(amountParam)
  if (!amountParam || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: 'amount must be a positive number' },
      { status: 400 },
    )
  }

  // Validate currency
  if (!currency || !isSupportedCurrency(currency)) {
    return NextResponse.json(
      { error: `Unsupported currency. Supported: USDC, USD` },
      { status: 400 },
    )
  }

  // Validate bankId
  if (!bankId) {
    return NextResponse.json({ error: 'bankId is required' }, { status: 400 })
  }

  const bankAccount = await prisma.bankAccount.findFirst({
    where: { id: bankId, userId: user.id },
    select: { id: true },
  })

  if (!bankAccount) {
    return NextResponse.json(
      { error: 'Bank account not found or does not belong to the user' },
      { status: 404 },
    )
  }

  const estimate = calculateWithdrawalFee(amount, currency)
  return NextResponse.json(estimate)
}
