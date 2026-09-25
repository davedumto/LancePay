import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Runs the four endpoints against a real Postgres database migrated to the
// current schema. Skipped unless TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgresql://postgres:pg@127.0.0.1:5432/lancepay npx vitest run tests/integration.badges-trust-reputation.test.ts

const DB_URL = process.env.TEST_DATABASE_URL

vi.mock('@/lib/db', async () => {
  const { PrismaClient } = await import('@prisma/client')
  return { prisma: new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL }) }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn(async (token: string) => ({ userId: token })) }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { POST as award } from '@/app/api/badges/award/route'
import { DELETE as revoke } from '@/app/api/badges/[badgeId]/revoke/route'
import { GET as trustScore } from '@/app/api/user-trust-score/route'
import { GET as reputation } from '@/app/api/clients/[id]/reputation/route'
import { recomputeUserTrustScore } from '@/lib/trust-score'

const run = randomUUID().slice(0, 8)
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

const ids = {
  freelancer: randomUUID(),
  admin: randomUUID(),
  stranger: randomUUID(),
  client: randomUUID(),
  badgeEarned: randomUUID(),
  badgeUnearned: randomUUID(),
}
const clientEmail = `client-${run}@example.com`

function user(id: string, role = 'freelancer', email = `${id}@example.com`, createdAt = new Date(now - 400 * DAY)) {
  return { id, privyId: `privy-${id}`, email, role, createdAt }
}

let invoiceSeq = 0
function invoice(userId: string, data: Record<string, unknown>) {
  invoiceSeq += 1
  return {
    userId,
    invoiceNumber: `INT-${run}-${invoiceSeq}`,
    paymentLink: `https://example.com/pay/${run}-${invoiceSeq}`,
    clientEmail: `other-${run}@example.com`,
    description: 'integration',
    amount: 100,
    ...data,
  }
}

const req = (url: string, privyOwner: string, init: RequestInit = {}) =>
  new NextRequest(url, { ...init, headers: { authorization: `Bearer privy-${privyOwner}`, 'content-type': 'application/json' } })

describe.skipIf(!DB_URL)('badges, trust score and client reputation against Postgres', () => {
  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        user(ids.freelancer),
        user(ids.admin, 'admin'),
        user(ids.stranger),
        user(ids.client, 'client', clientEmail),
      ],
    })
    await prisma.badgeDefinition.createMany({
      data: [
        { id: ids.badgeEarned, name: 'Verified Pro', criteriaJson: { type: 'invoices', minInvoices: 10 }, stellarAssetCode: `V${run}` },
        { id: ids.badgeUnearned, name: 'Top Earner', criteriaJson: { type: 'revenue', minRevenue: 1e6 }, stellarAssetCode: `T${run}` },
      ],
    })

    const past = (days: number) => new Date(now - days * DAY)
    // Freelancer: 10 paid invoices to unrelated clients, 2 cancelled, 1 disputed.
    await prisma.invoice.createMany({
      data: [
        ...Array.from({ length: 10 }, () => invoice(ids.freelancer, { status: 'paid', paidAt: past(30) })),
        invoice(ids.freelancer, { status: 'cancelled' }),
        invoice(ids.freelancer, { status: 'cancelled' }),
        // Client history, all from the freelancer:
        invoice(ids.freelancer, { clientEmail, clientId: ids.client, status: 'paid', dueDate: past(10), paidAt: past(12) }), // on time
        invoice(ids.freelancer, { clientEmail, status: 'paid', dueDate: past(10), paidAt: past(5) }), // late
        invoice(ids.freelancer, { clientEmail, status: 'pending', dueDate: past(3) }), // overdue → late
        invoice(ids.freelancer, { clientEmail, status: 'pending', dueDate: new Date(now + 10 * DAY) }), // no signal
      ],
    })
    const disputed = await prisma.invoice.create({
      data: invoice(ids.freelancer, { clientEmail, status: 'paid', dueDate: past(20), paidAt: past(25) }),
    })
    await prisma.dispute.create({
      data: { invoiceId: disputed.id, initiatedBy: 'client', initiatorEmail: clientEmail, reason: 'x', requestedAction: 'refund' },
    })
  })

  afterAll(async () => {
    const users = Object.values(ids)
    await prisma.dispute.deleteMany({ where: { invoice: { userId: { in: users } } } })
    await prisma.invoice.deleteMany({ where: { userId: { in: users } } })
    await prisma.userBadgeRevocation.deleteMany({ where: { userId: { in: users } } })
    await prisma.userBadge.deleteMany({ where: { userId: { in: users } } })
    await prisma.badgeDefinition.deleteMany({ where: { id: { in: [ids.badgeEarned, ids.badgeUnearned] } } })
    await prisma.userTrustScore.deleteMany({ where: { userId: { in: users } } })
    await prisma.clientReputation.deleteMany({ where: { clientEmail } })
    await prisma.user.deleteMany({ where: { id: { in: users } } })
    await prisma.$disconnect()
  })

  it('awards each earned badge exactly once under concurrent requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => award(req('http://localhost/api/badges/award', ids.freelancer, { method: 'POST' }))),
    )
    const bodies = await Promise.all(responses.map((r) => r.json()))

    const reported = bodies.flatMap((b) => b.awarded.map((a: any) => a.badgeId))
    expect(reported).toEqual([ids.badgeEarned])
    expect(await prisma.userBadge.count({ where: { userId: ids.freelancer } })).toBe(1)

    const again = await (await award(req('http://localhost/api/badges/award', ids.freelancer, { method: 'POST' }))).json()
    expect(again.awarded).toEqual([])
  })

  it('revokes once, audits the reason, and frees the badge to be re-earned', async () => {
    const url = `http://localhost/api/badges/${ids.badgeEarned}/revoke`
    const body = JSON.stringify({ userId: ids.freelancer, reason: 'Lost dispute on INV-1' })
    const ctx = { params: Promise.resolve({ badgeId: ids.badgeEarned }) }

    const statuses = await Promise.all(
      Array.from({ length: 3 }, () => revoke(req(url, ids.admin, { method: 'DELETE', body }), ctx).then((r) => r.status)),
    )
    expect(statuses.sort()).toEqual([200, 404, 404])

    const audit = await prisma.userBadgeRevocation.findMany({ where: { userId: ids.freelancer } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toEqual(expect.objectContaining({ trigger: 'admin', reason: 'Lost dispute on INV-1', revokedById: ids.admin }))
    expect(await prisma.userBadge.count({ where: { userId: ids.freelancer } })).toBe(0)

    const neverHeld = await revoke(
      req(`http://localhost/api/badges/${ids.badgeUnearned}/revoke`, ids.admin, { method: 'DELETE', body }),
      { params: Promise.resolve({ badgeId: ids.badgeUnearned }) },
    )
    expect(neverHeld.status).toBe(404)

    const reAward = await (await award(req('http://localhost/api/badges/award', ids.freelancer, { method: 'POST' }))).json()
    expect(reAward.awarded.map((a: any) => a.badgeId)).toEqual([ids.badgeEarned])
  })

  it('computes, caches and refuses to regress the trust score', async () => {
    const first = await (await trustScore(req('http://localhost/api/user-trust-score', ids.freelancer))).json()
    // 13 paid of 16 decided (1 pending not due excluded), 1 dispute, >1y old:
    // 50*14/18=38.9 + 24 + 20 = 82.9 → 83
    expect(first.score).toBe(83)
    expect(first.successfulInvoices).toBe(13)
    expect(first.disputeCount).toBe(1)

    const cachedAt = (await prisma.userTrustScore.findUniqueOrThrow({ where: { userId: ids.freelancer } })).lastUpdatedAt
    expect(cachedAt.toISOString()).toBe(first.lastUpdatedAt)

    const second = await (await trustScore(req('http://localhost/api/user-trust-score', ids.freelancer))).json()
    expect(second.lastUpdatedAt).toBe(first.lastUpdatedAt)

    const stale = await recomputeUserTrustScore(
      { id: ids.freelancer, createdAt: new Date(now) },
      new Date(cachedAt.getTime() - 60_000),
    )
    expect(stale.lastUpdatedAt).toEqual(cachedAt)
    expect(stale.score).toBe(83)
  })

  it('derives client reputation for the owning freelancer only', async () => {
    const ctx = { params: Promise.resolve({ id: ids.client }) }
    const url = `http://localhost/api/clients/${ids.client}/reputation`

    const owner = await reputation(req(url, ids.freelancer), ctx)
    // on-time 1, late 2 (paid late + overdue), disputed 1: 100*(1+1+1)/(4+2) = 50
    expect(owner.status).toBe(200)
    expect(await owner.json()).toEqual(expect.objectContaining({ clientId: ids.client, reputation: 50, hasHistory: true }))
    expect((await prisma.clientReputation.findUniqueOrThrow({ where: { clientEmail } })).paymentScore).toBe(50)

    const stranger = await reputation(req(url, ids.stranger), { params: Promise.resolve({ id: ids.client }) })
    expect(stranger.status).toBe(404)
  })
})
