import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

// PayoutItem.status values. `processing` is only held while a single-item
// retry is in flight; `cancelled` is set by the batch cancel endpoint.
export const ITEM_STATUS = {
  pending: 'pending',
  processing: 'processing',
  success: 'success',
  failed: 'failed',
  cancelled: 'cancelled',
} as const

export const NON_TERMINAL_ITEM_STATUSES = [ITEM_STATUS.pending, ITEM_STATUS.processing]

export const BATCH_STATUS = {
  pending: 'pending',
  completed: 'completed',
  cancelled: 'cancelled',
  processing: 'processing',
} as const

export interface PayoutBatchActor {
  id: string
  role: string
}

export async function resolvePayoutBatchActor(
  request: NextRequest,
): Promise<{ actor: PayoutBatchActor } | { response: NextResponse }> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const claims = await verifyAuthToken(authToken)
  if (!claims) return { response: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }

  const actor = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true },
  })
  if (!actor) return { response: NextResponse.json({ error: 'User not found' }, { status: 404 }) }

  return { actor }
}

export function isAdmin(actor: PayoutBatchActor) {
  return actor.role === 'admin'
}
