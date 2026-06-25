import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const actor = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true },
    })

    if (!actor) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    if (actor.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const limitParam = searchParams.get('limit')
    const offsetParam = searchParams.get('offset')

    const limit = Math.min(limitParam ? parseInt(limitParam, 10) : 20, 100)
    const offset = offsetParam ? parseInt(offsetParam, 10) : 0

    if (limitParam && (isNaN(limit) || limit <= 0)) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 })
    }
    if (offsetParam && (isNaN(offset) || offset < 0)) {
      return NextResponse.json({ error: 'Invalid offset parameter' }, { status: 400 })
    }

    const where: Record<string, unknown> = {}
    if (status) {
      where.status = status
    }

    const applications = await prisma.kycApplication.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })

    return NextResponse.json({ applications })
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
