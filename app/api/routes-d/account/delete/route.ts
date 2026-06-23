import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

/**
 * Grace period before a deletion request is allowed to execute. Keeps the
 * door open for support to cancel an accidental request and lines up with
 * the typical regulatory window for account-deletion withdrawal.
 */
const DELETION_GRACE_DAYS = 30
const MAX_REASON_LENGTH = 500

type AccountDeletionDelegate = {
  findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getDeletionDelegate(): AccountDeletionDelegate {
  return (prisma as unknown as { accountDeletionRequest: AccountDeletionDelegate }).accountDeletionRequest
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

function normalizeReason(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > MAX_REASON_LENGTH) return undefined

  return trimmed
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
    body = {}
  }

  const reason = normalizeReason((body as { reason?: unknown } | null | undefined)?.reason)
  if (reason === undefined) {
    return NextResponse.json(
      { error: `Reason must be at most ${MAX_REASON_LENGTH} characters` },
      { status: 400 },
    )
  }

  const deletionDelegate = getDeletionDelegate()

  // Prevent multiple pending requests so a UI bug or a refresh can't queue
  // a second deletion that would deactivate the account twice.
  const existing = await deletionDelegate.findFirst({
    where: { userId: user.id, status: 'pending' },
    select: { id: true, scheduledAt: true, createdAt: true },
  })

  if (existing) {
    return NextResponse.json(
      {
        id: existing.id,
        status: 'pending',
        scheduledAt: existing.scheduledAt,
        createdAt: existing.createdAt,
        message: 'A deletion request is already pending. Cancel it before raising a new one.',
      },
      { status: 409 },
    )
  }

  const scheduledAt = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000)

  const created = await deletionDelegate.create({
    data: {
      userId: user.id,
      reason,
      status: 'pending',
      scheduledAt,
    },
    select: {
      id: true,
      status: true,
      scheduledAt: true,
      createdAt: true,
    },
  })

  return NextResponse.json(
    {
      id: created.id,
      status: created.status,
      scheduledAt: created.scheduledAt,
      createdAt: created.createdAt,
      graceDays: DELETION_GRACE_DAYS,
    },
    { status: 202 },
  )
}
