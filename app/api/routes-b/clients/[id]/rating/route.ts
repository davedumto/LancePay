import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: any
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const client = await prisma.client.findFirst({
      where: { id: (await params)., userId: user.id },
    })
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

    const feedbacks = await prisma.clientFeedback.findMany({
      where: { clientId: (await params). },
      orderBy: { createdAt: 'desc' },
    })

    const totalReviews = feedbacks.length
    const averageRating =
      totalReviews > 0
        ? feedbacks.reduce((sum: number, f: any) => sum + (f.rating ?? 0), 0) / totalReviews
        : 0

    return NextResponse.json({
      clientId: (await params).,
      averageRating: Math.round(averageRating * 100) / 100,
      totalReviews,
      ratings: feedbacks.map((f: any) => ({
        id: f.id,
        rating: f.rating,
        comment: f.comment,
        createdAt: f.createdAt,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/clients/[id]/rating error')
    return NextResponse.json({ error: 'Failed to fetch client rating' }, { status: 500 })
  }
}
