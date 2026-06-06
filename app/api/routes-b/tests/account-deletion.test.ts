import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  requestAccountDeletion,
  cancelAccountDeletion,
  isAccountPendingDeletion,
  getDeletionRequest,
  getDeletionWindowEnd,
  checkAccountLocked,
} from '../_lib/account-state'

// ── account-state pure logic ──────────────────────────────────────────────────

describe('account-state helpers', () => {
  const userId = 'user-state-test'

  beforeEach(() => {
    // Cancel any leftover request from previous test
    cancelAccountDeletion(userId)
  })

  it('isAccountPendingDeletion returns false before any request', () => {
    expect(isAccountPendingDeletion(userId)).toBe(false)
  })

  it('requestAccountDeletion marks account pending and returns token + deletesAt', () => {
    const before = Date.now()
    const { token, deletesAt } = requestAccountDeletion(userId)
    const after = Date.now()
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
    const windowMs = 14 * 24 * 60 * 60 * 1000
    expect(deletesAt.getTime()).toBeGreaterThanOrEqual(before + windowMs)
    expect(deletesAt.getTime()).toBeLessThanOrEqual(after + windowMs)
    expect(isAccountPendingDeletion(userId)).toBe(true)
  })

  it('cancelAccountDeletion within window removes the request', () => {
    requestAccountDeletion(userId)
    expect(isAccountPendingDeletion(userId)).toBe(true)
    const result = cancelAccountDeletion(userId)
    expect(result).toBe(true)
    expect(isAccountPendingDeletion(userId)).toBe(false)
  })

  it('cancelAccountDeletion returns false when no pending request exists', () => {
    expect(cancelAccountDeletion(userId)).toBe(false)
  })

  it('getDeletionRequest returns null when no request', () => {
    expect(getDeletionRequest(userId)).toBeNull()
  })

  it('getDeletionRequest returns the stored entry after requesting', () => {
    requestAccountDeletion(userId)
    const req = getDeletionRequest(userId)
    expect(req).not.toBeNull()
    expect(req!.token).toBeTruthy()
    expect(req!.requestedAt).toBeInstanceOf(Date)
  })

  it('getDeletionWindowEnd returns null when no request', () => {
    expect(getDeletionWindowEnd(userId)).toBeNull()
  })

  it('getDeletionWindowEnd returns a date 14 days from requestedAt', () => {
    requestAccountDeletion(userId)
    const end = getDeletionWindowEnd(userId)
    expect(end).toBeInstanceOf(Date)
    const req = getDeletionRequest(userId)!
    expect(end!.getTime()).toBe(req.requestedAt.getTime() + 14 * 24 * 60 * 60 * 1000)
  })

  it('checkAccountLocked returns null when account is not locked', () => {
    expect(checkAccountLocked(userId)).toBeNull()
  })

  it('checkAccountLocked returns 423 response when account is locked', () => {
    requestAccountDeletion(userId)
    const response = checkAccountLocked(userId)
    expect(response).not.toBeNull()
    expect(response!.status).toBe(423)
  })

  it('isAccountPendingDeletion returns false after window expires (time-travel)', () => {
    // Manually insert an expired entry by overriding clock via requestedAt manipulation
    const { } = requestAccountDeletion(userId)
    const req = getDeletionRequest(userId)!
    // Backdate requestedAt by 15 days
    req.requestedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
    expect(isAccountPendingDeletion(userId)).toBe(false)
  })
})

// ── Route handler tests ───────────────────────────────────────────────────────

const mockAuditCreate = vi.hoisted(() => vi.fn().mockResolvedValue({}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn().mockResolvedValue({ userId: 'privy-1' }),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-route-1', privyId: 'privy-1' }),
    },
    auditEvent: {
      create: mockAuditCreate,
    },
  },
}))

import { POST as deleteRequest } from '../profile/delete-request/route'
import { POST as deleteCancel } from '../profile/delete-cancel/route'
import { prisma } from '@/lib/db'

function req(url: string) {
  return new Request(url, {
    method: 'POST',
    headers: { authorization: 'Bearer tok' },
  }) as any
}

// Use a dedicated userId for route tests to avoid collision with unit tests above
const ROUTE_USER_ID = 'user-route-1'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: ROUTE_USER_ID,
    privyId: 'privy-1',
  } as any)
  mockAuditCreate.mockResolvedValue({})
  // Ensure no leftover deletion state
  cancelAccountDeletion(ROUTE_USER_ID)
})

describe('POST /profile/delete-request', () => {
  it('returns 201-shape with token and deletesAt', async () => {
    const res = await deleteRequest(req('http://localhost/api/routes-b/profile/delete-request'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('confirmationToken')
    expect(body).toHaveProperty('deletesAt')
    expect(body.message).toMatch(/14 days/)
  })

  it('writes an audit event on request', async () => {
    await deleteRequest(req('http://localhost/api/routes-b/profile/delete-request'))
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'ACCOUNT_DELETION_REQUESTED' }),
      }),
    )
  })

  it('marks the account as locked after requesting', async () => {
    await deleteRequest(req('http://localhost/api/routes-b/profile/delete-request'))
    expect(isAccountPendingDeletion(ROUTE_USER_ID)).toBe(true)
  })

  it('returns 200 idempotently if already pending', async () => {
    await deleteRequest(req('http://localhost/api/routes-b/profile/delete-request'))
    // Request again
    const res2 = await deleteRequest(req('http://localhost/api/routes-b/profile/delete-request'))
    expect(res2.status).toBe(200)
    const body = await res2.json()
    expect(body.message).toMatch(/already requested/)
  })

  it('returns 401 without auth token', async () => {
    const res = await deleteRequest(
      new Request('http://localhost/api/routes-b/profile/delete-request', { method: 'POST' }) as any,
    )
    expect(res.status).toBe(401)
  })
})

describe('POST /profile/delete-cancel', () => {
  it('returns 200 after successful cancel within window', async () => {
    // First: request deletion
    await deleteRequest(req('http://localhost/api/routes-b/profile/delete-request'))
    // Then: cancel
    const res = await deleteCancel(req('http://localhost/api/routes-b/profile/delete-cancel'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toMatch(/cancelled/)
  })

  it('writes an audit event on cancel', async () => {
    await deleteRequest(req('http://localhost/api/routes-b/profile/delete-request'))
    mockAuditCreate.mockClear()
    await deleteCancel(req('http://localhost/api/routes-b/profile/delete-cancel'))
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'ACCOUNT_DELETION_CANCELLED' }),
      }),
    )
  })

  it('clears the lock after cancel', async () => {
    await deleteRequest(req('http://localhost/api/routes-b/profile/delete-request'))
    await deleteCancel(req('http://localhost/api/routes-b/profile/delete-cancel'))
    expect(isAccountPendingDeletion(ROUTE_USER_ID)).toBe(false)
  })

  it('returns 409 when no active deletion request exists', async () => {
    const res = await deleteCancel(req('http://localhost/api/routes-b/profile/delete-cancel'))
    expect(res.status).toBe(409)
  })

  it('returns 409 after window has already expired', async () => {
    // Set up an expired deletion request
    requestAccountDeletion(ROUTE_USER_ID)
    const req2 = getDeletionRequest(ROUTE_USER_ID)!
    req2.requestedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)

    // isAccountPendingDeletion should now return false (expired)
    const res = await deleteCancel(req('http://localhost/api/routes-b/profile/delete-cancel'))
    expect(res.status).toBe(409)
  })
})

describe('checkAccountLocked gating', () => {
  it('checkAccountLocked returns 423 for locked account', () => {
    requestAccountDeletion(ROUTE_USER_ID)
    const response = checkAccountLocked(ROUTE_USER_ID)
    expect(response).not.toBeNull()
    expect(response!.status).toBe(423)
  })

  it('checkAccountLocked returns null for unlocked account', () => {
    cancelAccountDeletion(ROUTE_USER_ID)
    expect(checkAccountLocked(ROUTE_USER_ID)).toBeNull()
  })

  it('gating unblocks after cancellation', async () => {
    requestAccountDeletion(ROUTE_USER_ID)
    expect(checkAccountLocked(ROUTE_USER_ID)!.status).toBe(423)
    cancelAccountDeletion(ROUTE_USER_ID)
    expect(checkAccountLocked(ROUTE_USER_ID)).toBeNull()
  })
})
