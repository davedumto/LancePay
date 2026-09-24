import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  securityWatchlist: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
  securityWatchlistRemovalAudit: { create: vi.fn() },
  incomeVerification: { findMany: vi.fn(), create: vi.fn() },
  sanctionsScreening: { findUnique: vi.fn(), update: vi.fn() },
  sanctionsAppeal: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}))
const verifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { GET as getWatchlist, POST as postWatchlist } from '@/app/api/security-watchlist/route'
import { DELETE as deleteWatchlist } from '@/app/api/security-watchlist/[id]/route'
import { GET as getVerifications, POST as postVerification } from '@/app/api/income-verifications/route'
import { POST as postAppeal } from '@/app/api/sanctions-screenings/[id]/appeal/route'

const authHeaders = { authorization: 'Bearer valid-token', 'content-type': 'application/json' }

function request(path: string, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: authHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
  db.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'admin@example.com', role: 'admin' })
  db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db))
})

describe('security watchlist routes', () => {
  it('lists entries for a compliance actor', async () => {
    db.securityWatchlist.findMany.mockResolvedValue([{ id: 'watch-1', value: 'GABC' }])
    const response = await getWatchlist(request('/api/security-watchlist'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ entries: [{ id: 'watch-1' }] })
  })

  it('creates a justified entry and maps duplicates to 409', async () => {
    db.securityWatchlist.create.mockResolvedValueOnce({ id: 'watch-1', type: 'address', value: 'GABC', reason: 'sanctions match' })
    const created = await postWatchlist(request('/api/security-watchlist', 'POST', {
      type: 'address', value: 'GABC', reason: 'sanctions match',
    }))
    expect(created.status).toBe(201)

    db.securityWatchlist.create.mockRejectedValueOnce({ code: 'P2002' })
    const duplicate = await postWatchlist(request('/api/security-watchlist', 'POST', {
      type: 'address', value: 'GABC', reason: 'another match',
    }))
    expect(duplicate.status).toBe(409)
  })

  it('requires a non-empty addition reason and compliance role', async () => {
    const missingReason = await postWatchlist(request('/api/security-watchlist', 'POST', {
      type: 'address', value: 'GABC', reason: '  ',
    }))
    expect(missingReason.status).toBe(400)

    db.user.findUnique.mockResolvedValueOnce({ id: 'user-1', email: 'user@example.com', role: 'freelancer' })
    const forbidden = await getWatchlist(request('/api/security-watchlist'))
    expect(forbidden.status).toBe(403)
  })

  it('audits distinct removal reasons before deleting and returns 404 when absent', async () => {
    db.securityWatchlist.findUnique.mockResolvedValueOnce({
      id: 'watch-1', type: 'address', value: 'GABC', reason: 'provider match',
    })
    db.securityWatchlistRemovalAudit.create.mockResolvedValue({ id: 'audit-1' })
    db.securityWatchlist.delete.mockResolvedValue({ id: 'watch-1' })
    const removed = await deleteWatchlist(
      request('/api/security-watchlist/watch-1', 'DELETE', { reason: 'confirmed false positive' }),
      { params: { id: 'watch-1' } },
    )
    expect(removed.status).toBe(200)
    expect(db.securityWatchlistRemovalAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ additionReason: 'provider match', removalReason: 'confirmed false positive' }),
    })
    expect(db.securityWatchlist.delete).toHaveBeenCalled()

    db.securityWatchlist.findUnique.mockResolvedValueOnce(null)
    const absent = await deleteWatchlist(
      request('/api/security-watchlist/watch-1', 'DELETE', { reason: 'false positive' }),
      { params: Promise.resolve({ id: 'watch-1' }) },
    )
    expect(absent.status).toBe(404)
  })

  it('rejects a removal reason that repeats the addition reason', async () => {
    db.securityWatchlist.findUnique.mockResolvedValue({
      id: 'watch-1', type: 'address', value: 'GABC', reason: 'Provider match',
    })
    const response = await deleteWatchlist(
      request('/api/security-watchlist/watch-1', 'DELETE', { reason: ' provider MATCH ' }),
      { params: { id: 'watch-1' } },
    )
    expect(response.status).toBe(400)
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})

describe('income verification routes', () => {
  it('stores only a hash and returns the raw token once', async () => {
    db.incomeVerification.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'verification-1', recipientName: data.recipientName, expiresAt: data.expiresAt,
      accessCount: data.accessCount, createdAt: new Date(),
    }))
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const response = await postVerification(request('/api/income-verifications', 'POST', {
      expiresAt, recipientName: 'Mortgage Provider',
    }))
    expect(response.status).toBe(201)
    const payload = await response.json()
    expect(payload.token).toEqual(expect.any(String))
    const createData = db.incomeVerification.create.mock.calls[0][0].data
    expect(createData.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(createData.tokenHash).not.toBe(payload.token)
    expect(createData.accessCount).toBe(0)
  })

  it('rejects missing, expired, and excessively distant expiry dates', async () => {
    const missing = await postVerification(request('/api/income-verifications', 'POST', {}))
    expect(missing.status).toBe(400)
    const expired = await postVerification(request('/api/income-verifications', 'POST', {
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }))
    expect(expired.status).toBe(400)
    const distant = await postVerification(request('/api/income-verifications', 'POST', {
      expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
    }))
    expect(distant.status).toBe(400)
  })

  it('lists metadata without exposing token hashes', async () => {
    db.incomeVerification.findMany.mockResolvedValue([{ id: 'verification-1', accessCount: 0 }])
    const response = await getVerifications(request('/api/income-verifications'))
    expect(response.status).toBe(200)
    expect(db.incomeVerification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.not.objectContaining({ tokenHash: true }),
    }))
  })
})

describe('sanctions screening appeals', () => {
  it('creates a pending appeal and transitions a flagged screening', async () => {
    db.sanctionsScreening.findUnique.mockResolvedValue({ id: 'screen-1', userId: 'user-1', status: 'flagged' })
    db.sanctionsAppeal.findFirst.mockResolvedValue(null)
    db.sanctionsAppeal.create.mockResolvedValue({ id: 'appeal-1', status: 'pending' })
    db.sanctionsScreening.update.mockResolvedValue({ id: 'screen-1', status: 'under_review' })
    const response = await postAppeal(
      request('/api/sanctions-screenings/screen-1/appeal', 'POST', { reason: 'This is a false match' }),
      { params: { id: 'screen-1' } },
    )
    expect(response.status).toBe(201)
    expect(db.sanctionsScreening.update).toHaveBeenCalledWith({
      where: { id: 'screen-1' }, data: { status: 'under_review' },
    })
  })

  it('rejects clear screenings, other users, and duplicate pending appeals', async () => {
    db.sanctionsScreening.findUnique.mockResolvedValueOnce({ id: 'screen-1', userId: 'user-1', status: 'clear' })
    const clear = await postAppeal(
      request('/api/sanctions-screenings/screen-1/appeal', 'POST', { reason: 'Incorrect' }),
      { params: { id: 'screen-1' } },
    )
    expect(clear.status).toBe(409)

    db.sanctionsScreening.findUnique.mockResolvedValueOnce({ id: 'screen-1', userId: 'other', status: 'flagged' })
    const hidden = await postAppeal(
      request('/api/sanctions-screenings/screen-1/appeal', 'POST', { reason: 'Incorrect' }),
      { params: { id: 'screen-1' } },
    )
    expect(hidden.status).toBe(404)

    db.sanctionsScreening.findUnique.mockResolvedValueOnce({ id: 'screen-1', userId: 'user-1', status: 'under_review' })
    db.sanctionsAppeal.findFirst.mockResolvedValueOnce({ id: 'appeal-1' })
    const duplicate = await postAppeal(
      request('/api/sanctions-screenings/screen-1/appeal', 'POST', { reason: 'More evidence' }),
      { params: { id: 'screen-1' } },
    )
    expect(duplicate.status).toBe(409)
  })
})
