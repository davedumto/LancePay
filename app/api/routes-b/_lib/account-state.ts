import { NextResponse } from 'next/server'

const DELETION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

export type DeletionRequest = {
  requestedAt: Date
  token: string
}

// In-process store: userId → deletion request
const deletionStore = new Map<string, DeletionRequest>()

export function requestAccountDeletion(userId: string): { token: string; deletesAt: Date } {
  const token = crypto.randomUUID()
  const requestedAt = new Date()
  deletionStore.set(userId, { requestedAt, token })
  return { token, deletesAt: new Date(requestedAt.getTime() + DELETION_WINDOW_MS) }
}

export function cancelAccountDeletion(userId: string): boolean {
  if (!deletionStore.has(userId)) return false
  deletionStore.delete(userId)
  return true
}

export function getDeletionRequest(userId: string): DeletionRequest | null {
  return deletionStore.get(userId) ?? null
}

export function isAccountPendingDeletion(userId: string): boolean {
  const req = deletionStore.get(userId)
  if (!req) return false
  const windowEnd = req.requestedAt.getTime() + DELETION_WINDOW_MS
  if (Date.now() >= windowEnd) {
    // Window has passed — clean up
    deletionStore.delete(userId)
    return false
  }
  return true
}

export function getDeletionWindowEnd(userId: string): Date | null {
  const req = deletionStore.get(userId)
  if (!req) return null
  return new Date(req.requestedAt.getTime() + DELETION_WINDOW_MS)
}

/**
 * Returns a 423 Locked response if the account has an active deletion window,
 * otherwise returns null (caller may proceed).
 */
export function checkAccountLocked(userId: string): NextResponse | null {
  if (isAccountPendingDeletion(userId)) {
    return NextResponse.json(
      { error: 'Account is pending deletion', code: 'ACCOUNT_LOCKED' },
      { status: 423 },
    )
  }
  return null
}
