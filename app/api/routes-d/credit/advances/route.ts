import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

/**
 * GET /api/routes-d/credit/advances
 * Get all payment advances for authenticated user
 */
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers
      .get('authorization')
      ?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const advances = await prisma.paymentAdvance.findMany({
      where: { userId: user.id },
      include: {
        invoice: {
          select: {
            invoiceNumber: true,
            amount: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      success: true,
      advances: advances.map((adv) => ({
        id: adv.id,
        invoiceNumber: adv.invoice.invoiceNumber,
        invoiceAmount: Number(adv.invoice.amount),
        invoiceStatus: adv.invoice.status,
        advancedAmount: Number(adv.advancedAmountUSDC),
        ngnAmount: Number(adv.advancedAmountNGN),
        feeAmount: Number(adv.feeAmountUSDC),
        totalRepayment: Number(adv.totalRepaymentUSDC),
        status: adv.status,
        disbursedAt: adv.disbursedAt?.toISOString(),
        repaidAt: adv.repaidAt?.toISOString(),
        createdAt: adv.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    console.error('Get advances error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch advances' },
      { status: 500 }
    )
  }
}
