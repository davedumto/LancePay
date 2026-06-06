import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

const SAVED_QUERY_CAP = 50

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const savedQueries = await (prisma as any).savedSearch.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, query: true, filters: true, createdAt: true },
    })

    return NextResponse.json({ savedQueries })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B saved search GET error')
    return NextResponse.json({ error: 'Failed to list saved searches' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json()

    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (body.name.length > 100) {
      return NextResponse.json({ error: 'name must be 100 characters or fewer' }, { status: 400 })
    }
    if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 })
    }

    const count = await (prisma as any).savedSearch.count({ where: { userId: user.id } })
    if (count >= SAVED_QUERY_CAP) {
      return NextResponse.json(
        { error: `Saved query limit of ${SAVED_QUERY_CAP} reached` },
        { status: 422 },
      )
    }

    const saved = await (prisma as any).savedSearch.create({
      data: {
        userId: user.id,
        name: body.name.trim(),
        query: body.query.trim(),
        filters: body.filters ?? null,
      },
      select: { id: true, name: true, query: true, filters: true, createdAt: true },
    })

    return NextResponse.json({ savedQuery: saved }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B saved search POST error')
    return NextResponse.json({ error: 'Failed to create saved search' }, { status: 500 })
  }
}
