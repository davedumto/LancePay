import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    const saved = await (prisma as any).savedSearch.findFirst({
      where: { id, userId: user.id },
      select: { id: true, name: true, query: true, filters: true, createdAt: true },
    })

    if (!saved) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ savedQuery: saved })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B saved search [id] GET error')
    return NextResponse.json({ error: 'Failed to get saved search' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    const existing = await (prisma as any).savedSearch.findFirst({
      where: { id, userId: user.id },
    })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    await (prisma as any).savedSearch.delete({ where: { id } })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B saved search [id] DELETE error')
    return NextResponse.json({ error: 'Failed to delete saved search' }, { status: 500 })
  }
}
