import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

const MAX_LIMIT = 50
const DEFAULT_LIMIT = 20

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const actor = await prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true, role: true } })
    if (!actor) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (!isAdmin(actor)) {
      return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q')?.trim()

    if (!q) {
      return NextResponse.json({ error: 'q is required' }, { status: 400 })
    }

    const limitParam = searchParams.get('limit')
    let limit = DEFAULT_LIMIT
    if (limitParam !== null) {
      const parsed = Number(limitParam)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return NextResponse.json({ error: 'limit must be a positive integer' }, { status: 400 })
      }
      limit = Math.min(parsed, MAX_LIMIT)
    }

    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ users, count: users.length })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/admin/users/search error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
