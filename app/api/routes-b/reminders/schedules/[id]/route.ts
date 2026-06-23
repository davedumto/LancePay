import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function PATCH(
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

    const schedule = await prisma.reminderSchedule.findFirst({
      where: { id, userId: user.id },
    })

    if (!schedule) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })
    }

    const body = await request.json()
    const { name, description, frequency, interval, timezone, enabled, metadata, nextRunAt } = body

    const validFrequencies = ['daily', 'weekly', 'monthly', 'yearly']
    if (frequency && !validFrequencies.includes(frequency)) {
      return NextResponse.json(
        { error: 'frequency must be one of: daily, weekly, monthly, yearly' },
        { status: 400 },
      )
    }

    if (interval !== undefined && interval < 1) {
      return NextResponse.json(
        { error: 'interval must be a positive integer' },
        { status: 400 },
      )
    }

    const updated = await prisma.reminderSchedule.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(frequency !== undefined && { frequency }),
        ...(interval !== undefined && { interval }),
        ...(timezone !== undefined && { timezone }),
        ...(enabled !== undefined && { enabled }),
        ...(metadata !== undefined && { metadata }),
        ...(nextRunAt !== undefined && { nextRunAt: nextRunAt ? new Date(nextRunAt) : null }),
      },
    })

    return NextResponse.json(updated)
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
