import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        invoice: { select: { invoiceNumber: true, clientName: true, description: true } },
        bankAccount: { select: { bankName: true, accountNumber: true } }
      }
    })

    const formatted = transactions.map((tx: any) => ({
      id: tx.id,
      type: tx.type,
      status: tx.status,
      amount: Number(tx.amount),
      currency: tx.currency,
      createdAt: tx.createdAt,
      invoice: tx.invoice,
      bankAccount: tx.bankAccount,
    }))

    return NextResponse.json({ transactions: formatted })
  } catch (error) {
    console.error('Transactions GET error:', error)
    return NextResponse.json({ error: 'Failed to get transactions' }, { status: 500 })
  }
}
