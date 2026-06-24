import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const MAX_TITLE_LENGTH = 100
const MAX_GOAL_TARGET_USDC = 1_000_000_000 // hard ceiling — well above any realistic goal

type SavingsGoalDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getGoalDelegate(): SavingsGoalDelegate {
  return (prisma as unknown as { savingsGoal: SavingsGoalDelegate }).savingsGoal
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

function decimalToString(value: unknown): string {
  if (value === null || value === undefined) return '0'
  if (typeof (value as { toString?: () => string })?.toString === 'function') {
    return (value as { toString: () => string }).toString()
  }
  return String(value)
}

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_TITLE_LENGTH) return null
  return trimmed
}

function normalizeAmount(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_GOAL_TARGET_USDC) return null
    return value.toString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null
    const num = Number.parseFloat(trimmed)
    if (!Number.isFinite(num) || num <= 0 || num > MAX_GOAL_TARGET_USDC) return null
    return trimmed
  }
  return null
}

function normalizePercentage(value: unknown): number | null {
  let num: number | null = null
  if (typeof value === 'number') num = value
  else if (typeof value === 'string' && value.trim() !== '') num = Number(value)

  if (num === null || !Number.isFinite(num)) return null
  if (!Number.isInteger(num)) return null
  if (num < 0 || num > 100) return null
  return num
}

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const goalDelegate = getGoalDelegate()
  const goals = await goalDelegate.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      targetAmountUsdc: true,
      currentAmountUsdc: true,
      savingsPercentage: true,
      isActive: true,
      status: true,
      isTaxVault: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return NextResponse.json({
    goals: goals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      targetAmountUsdc: decimalToString(goal.targetAmountUsdc),
      currentAmountUsdc: decimalToString(goal.currentAmountUsdc),
      savingsPercentage: goal.savingsPercentage,
      isActive: goal.isActive,
      status: goal.status,
      isTaxVault: goal.isTaxVault,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    })),
  })
}

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload = (body ?? {}) as Record<string, unknown>

  const title = normalizeTitle(payload.title)
  if (!title) {
    return NextResponse.json(
      { error: `Title is required and must be at most ${MAX_TITLE_LENGTH} characters` },
      { status: 400 },
    )
  }

  const targetAmountUsdc = normalizeAmount(payload.targetAmountUsdc)
  if (!targetAmountUsdc) {
    return NextResponse.json(
      { error: 'targetAmountUsdc must be a positive amount with up to 6 decimal places' },
      { status: 400 },
    )
  }

  const savingsPercentage = normalizePercentage(payload.savingsPercentage)
  if (savingsPercentage === null) {
    return NextResponse.json(
      { error: 'savingsPercentage must be an integer between 0 and 100' },
      { status: 400 },
    )
  }

  const isTaxVault = payload.isTaxVault === true

  const goalDelegate = getGoalDelegate()
  const created = await goalDelegate.create({
    data: {
      userId: user.id,
      title,
      targetAmountUsdc,
      savingsPercentage,
      isTaxVault,
    },
    select: {
      id: true,
      title: true,
      targetAmountUsdc: true,
      currentAmountUsdc: true,
      savingsPercentage: true,
      isActive: true,
      status: true,
      isTaxVault: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return NextResponse.json(
    {
      id: created.id,
      title: created.title,
      targetAmountUsdc: decimalToString(created.targetAmountUsdc),
      currentAmountUsdc: decimalToString(created.currentAmountUsdc),
      savingsPercentage: created.savingsPercentage,
      isActive: created.isActive,
      status: created.status,
      isTaxVault: created.isTaxVault,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    },
    { status: 201 },
  )
}
