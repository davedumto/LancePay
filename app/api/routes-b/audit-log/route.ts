import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    // Verify auth
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
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

    // Parse query parameters
    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)))
    const action = searchParams.get('action')

    // Build where clause
    const where: any = {
      actorId: user.id,
    }

    if (action) {
      where.eventType = action
    }

    // Get total count
    const total = await prisma.auditEvent.count({ where })

    // Fetch events, newest first
    const events = await prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    })

    // Format response
    const formattedEvents = events.map((event) => {
      const metadata = event.metadata as any
      return {
        id: event.id,
        action: event.eventType,
        resourceType: 'invoice',
        resourceId: event.invoiceId,
        ipAddress: metadata?.ip || '',
        createdAt: event.createdAt,
      }
    })

    return NextResponse.json({
      events: formattedEvents,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Audit log list error')
    return NextResponse.json({ error: 'Failed to list audit events' }, { status: 500 })
  }
}