import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Note: TimeEntry model would need to be added to the Prisma schema
    // This is a placeholder implementation assuming the model exists
    const timeEntry = await (prisma as any).timeEntry.findFirst({
      where: { id, userId: user.id },
    })

    if (!timeEntry) {
      return NextResponse.json({ error: 'Time entry not found' }, { status: 404 })
    }

    return NextResponse.json(timeEntry)
  } catch (error) {
    logger.error({ err: error }, 'Time entry fetch error')
    return NextResponse.json({ error: 'Failed to fetch time entry' }, { status: 500 })
  }
}
