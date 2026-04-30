import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createSchedule, getSchedules } from '../../_lib/withdrawal-scheduler'

async function GETHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const userSchedules = getSchedules(user.id)
  return NextResponse.json({ schedules: userSchedules })
}

async function POSTHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Refuse if no default bank account exists
  const defaultBank = await prisma.bankAccount.findFirst({
    where: { userId: user.id, isDefault: true }
  })
  if (!defaultBank) {
    return NextResponse.json({ error: 'No default bank account exists' }, { status: 400 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { bankId, cadence, dayOfWeek, dayOfMonth, percentOrAmount } = body

  if (!bankId || typeof bankId !== 'string') return NextResponse.json({ error: 'bankId required' }, { status: 400 })
  if (cadence !== 'weekly' && cadence !== 'monthly') return NextResponse.json({ error: 'Invalid cadence' }, { status: 400 })
  if (cadence === 'weekly' && (typeof dayOfWeek !== 'number' || dayOfWeek < 0 || dayOfWeek > 6)) return NextResponse.json({ error: 'Invalid dayOfWeek' }, { status: 400 })
  if (cadence === 'monthly' && (typeof dayOfMonth !== 'number' || dayOfMonth < 1 || dayOfMonth > 31)) return NextResponse.json({ error: 'Invalid dayOfMonth' }, { status: 400 })
  if (!percentOrAmount || !['percent', 'amount'].includes(percentOrAmount.type) || typeof percentOrAmount.value !== 'number') {
    return NextResponse.json({ error: 'Invalid percentOrAmount' }, { status: 400 })
  }

  const bankAccount = await prisma.bankAccount.findFirst({
    where: { id: bankId, userId: user.id }
  })
  if (!bankAccount) {
    return NextResponse.json({ error: 'Bank account not found or does not belong to user' }, { status: 403 })
  }

  const schedule = createSchedule({
    userId: user.id,
    bankId,
    cadence,
    dayOfWeek,
    dayOfMonth,
    percentOrAmount
  })

  return NextResponse.json({ schedule }, { status: 201 })
}

export const GET = withRequestId(GETHandler)
export const POST = withRequestId(POSTHandler)
