/**
 * Tests for issue #604 — invoice share links
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mintShareToken, lookupShareToken, revokeShareToken, clearShareTokenStore } from '../_lib/share-tokens'
import { resetRateLimitBuckets } from '../_lib/rate-limit'

// ── unit tests for token store ────────────────────────────────────────────────

describe('share-tokens', () => {
  beforeEach(() => {
    clearShareTokenStore()
  })

  it('mints a token with correct fields', () => {
    const entry = mintShareToken('inv-1', 'user-1')
    expect(entry.token).toBeTruthy()
    expect(entry.invoiceId).toBe('inv-1')
    expect(entry.userId).toBe('user-1')
    expect(entry.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(entry.revokedAt).toBeUndefined()
  })

  it('token is 32-byte base64url (43 chars)', () => {
    const { token } = mintShareToken('inv-1', 'user-1')
    // base64url of 32 bytes = 43 chars (no padding)
    expect(token.length).toBe(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('lookup returns minted token', () => {
    const { token } = mintShareToken('inv-1', 'user-1')
    const found = lookupShareToken(token)
    expect(found).not.toBeNull()
    expect(found!.invoiceId).toBe('inv-1')
  })

  it('lookup returns null for unknown token', () => {
    expect(lookupShareToken('nonexistent')).toBeNull()
  })

  it('revoke marks token as revoked', () => {
    const { token } = mintShareToken('inv-1', 'user-1')
    const ok = revokeShareToken(token, 'user-1')
    expect(ok).toBe(true)
    expect(lookupShareToken(token)!.revokedAt).toBeDefined()
  })

  it('revoke fails for wrong user', () => {
    const { token } = mintShareToken('inv-1', 'user-1')
    const ok = revokeShareToken(token, 'user-2')
    expect(ok).toBe(false)
  })

  it('expired token: expiresAt in the past', () => {
    const entry = mintShareToken('inv-1', 'user-1', 0) // 0 days = already expired
    expect(entry.expiresAt.getTime()).toBeLessThanOrEqual(Date.now())
  })
})

// ── route handler tests ───────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn().mockResolvedValue({ userId: 'privy-user-1' }),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-1', privyId: 'privy-user-1' }),
    },
    invoice: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}))

import { POST as postShareLink } from '../invoices/[id]/share-link/route'
import { GET as getPublic } from '../invoices/public/[token]/route'
import { prisma } from '@/lib/db'

function makePostReq(id: string) {
  return new Request(`http://localhost/api/routes-b/invoices/${id}/share-link`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok' },
  }) as any
}

function makeGetReq(token: string) {
  return new Request(`http://localhost/api/routes-b/invoices/public/${token}`, {
    headers: {},
  }) as any
}

describe('POST /invoices/[id]/share-link', () => {
  beforeEach(() => {
    clearShareTokenStore()
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: 'inv-1' } as any)
  })

  it('mints a share link', async () => {
    const res = await postShareLink(makePostReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toHaveProperty('token')
    expect(body).toHaveProperty('url')
    expect(body).toHaveProperty('expiresAt')
  })

  it('returns 404 for unknown invoice', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValueOnce(null)
    const res = await postShareLink(makePostReq('bad-id'), { params: Promise.resolve({ id: 'bad-id' }) })
    expect(res.status).toBe(404)
  })
})

describe('GET /invoices/public/[token]', () => {
  beforeEach(() => {
    clearShareTokenStore()
    resetRateLimitBuckets()
    vi.mocked(prisma.invoice.findUnique).mockResolvedValue({
      invoiceNumber: 'INV-001',
      clientName: 'Acme',
      description: 'Work',
      amount: 100,
      currency: 'USD',
      status: 'pending',
      dueDate: null,
      createdAt: new Date(),
    } as any)
  })

  it('returns redacted invoice for valid token', async () => {
    const { token } = mintShareToken('inv-1', 'user-1')
    const res = await getPublic(makeGetReq(token), { params: Promise.resolve({ token }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('invoiceNumber')
    expect(body).not.toHaveProperty('clientEmail')
    expect(body).not.toHaveProperty('paymentLink')
    expect(body).not.toHaveProperty('id')
  })

  it('rejects expired token with 410', async () => {
    const entry = mintShareToken('inv-1', 'user-1', 0)
    // Force expiry
    entry.expiresAt = new Date(Date.now() - 1000)
    const res = await getPublic(makeGetReq(entry.token), { params: Promise.resolve({ token: entry.token }) })
    expect(res.status).toBe(410)
  })

  it('rejects revoked token with 410', async () => {
    const { token } = mintShareToken('inv-1', 'user-1')
    revokeShareToken(token, 'user-1')
    const res = await getPublic(makeGetReq(token), { params: Promise.resolve({ token }) })
    expect(res.status).toBe(410)
  })

  it('rejects unknown token with 404', async () => {
    const res = await getPublic(makeGetReq('unknown-token'), { params: Promise.resolve({ token: 'unknown-token' }) })
    expect(res.status).toBe(404)
  })

  it('rate limit kicks in after 60 requests', async () => {
    const { token } = mintShareToken('inv-1', 'user-1')
    let lastStatus = 200
    for (let i = 0; i < 62; i++) {
      const res = await getPublic(makeGetReq(token), { params: Promise.resolve({ token }) })
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
  })
})
