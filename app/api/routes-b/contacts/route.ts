import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { listContacts } from '../_lib/contacts'

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

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')
    const includeDeleted = searchParams.get('includeDeleted') === 'true'

    if (includeDeleted && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const contacts = await listContacts({
      userId: user.id,
      search,
      includeDeleted,
    })

    return NextResponse.json({ contacts })
  } catch (error) {
    logger.error({ err: error }, 'Routes B contacts GET error')
    return NextResponse.json({ error: 'Failed to get contacts' }, { status: 500 })
  }
}
