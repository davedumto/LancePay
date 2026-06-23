import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const schedules = await prisma.reminderSchedule.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        frequency: true,
        interval: true,
        timezone: true,
        enabled: true,
        nextRunAt: true,
        lastRunAt: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ schedules })
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const { name, description, frequency, interval = 1, timezone, enabled = true, metadata = {} } = body

    if (!name || !frequency) {
      return NextResponse.json(
        { error: 'name and frequency are required' },
        { status: 400 },
      )
    }

    const validFrequencies = ['daily', 'weekly', 'monthly', 'yearly']
    if (!validFrequencies.includes(frequency)) {
      return NextResponse.json(
        { error: 'frequency must be one of: daily, weekly, monthly, yearly' },
        { status: 400 },
      )
    }

    if (interval < 1) {
      return NextResponse.json(
        { error: 'interval must be a positive integer' },
        { status: 400 },
      )
    }

    const schedule = await prisma.reminderSchedule.create({
      data: {
        userId: user.id,
        name,
        description,
        frequency,
        interval,
        timezone,
        enabled,
        metadata,
      },
    })

    return NextResponse.json(schedule, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
