import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPublicTrustScoreData } from '@/lib/reputation'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const publicData = await getPublicTrustScoreData(userId)

    if (!publicData) {
      return NextResponse.json(
        { error: 'Failed to fetch trust score' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      score: publicData.score,
      tier: publicData.tier,
      totalPaidInvoices: publicData.totalPaidInvoices,
      isVerified: publicData.isVerified,
    })
  } catch (error) {
    console.error('Error fetching public trust score:', error)
    return NextResponse.json(
      { error: 'Failed to fetch trust score' },
      { status: 500 }
    )
  }
}
