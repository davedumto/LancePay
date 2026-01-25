import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    // Find or create user
    let user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    
    if (!user) {
      const email = (claims as any).email || `${claims.userId}@privy.local`
      user = await prisma.user.create({
        data: { privyId: claims.userId, email },
      })
    }

    const paidInvoices = await prisma.invoice.aggregate({
      where: { userId: user.id, status: 'paid' },
      _sum: { amount: true },
    })

    const withdrawals = await prisma.transaction.aggregate({
      where: { userId: user.id, type: 'withdrawal', status: 'completed' },
      _sum: { amount: true },
    })

    const totalIncoming = Number(paidInvoices._sum.amount || 0)
    const totalWithdrawn = Number(withdrawals._sum.amount || 0)
    const usdAmount = totalIncoming - totalWithdrawn
    const exchangeRate = 1600
    const ngnAmount = usdAmount * exchangeRate

    const pendingInvoices = await prisma.invoice.aggregate({
      where: { userId: user.id, status: 'pending' },
      _sum: { amount: true },
    })

    // XLM reserve (Stellar base reserve is 1 XLM + 0.5 XLM per trustline/entry)
    // Default is ~1.5 XLM for a typical account with USDC trustline
    const xlmReserve = 1.5

    return NextResponse.json({
      available: { amount: usdAmount, currency: 'USD', display: `$${usdAmount.toFixed(2)}` },
      localEquivalent: { amount: ngnAmount, currency: 'NGN', display: `₦${ngnAmount.toLocaleString()}`, rate: exchangeRate },
      pending: { amount: Number(pendingInvoices._sum.amount || 0), currency: 'USD' },
      xlm: xlmReserve,
    })
  } catch (error) {
    console.error('Balance GET error:', error)
    return NextResponse.json({ error: 'Failed to get balance' }, { status: 500 })
  }
}
