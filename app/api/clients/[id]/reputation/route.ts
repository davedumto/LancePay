import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  calculateClientReputation,
  loadClientPaymentSignals,
  NEUTRAL_CLIENT_REPUTATION,
  saveClientReputation,
} from '@/lib/client-reputation'

// GET /api/clients/[id]/reputation
//
// `id` is the client's User id (as in Invoice.clientId, ClientNote.clientId and
// ClientPortalSession.clientId). Only a freelancer who has invoiced this client
// — by linked clientId or by the client's email — may read it; anyone else gets
// the same 404 as a nonexistent client so ids cannot be probed.
//
// The reputation is derived from the payment behaviour on every invoice
// addressed to the client's email and cached on the email-keyed
// ClientReputation row that payment-advance eligibility already reads. Only the
// derived figure is returned, never the underlying invoices or disputes.
// Formula: lib/client-reputation.ts.

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) {
      return NextResponse.json({ error: 'Invalid client id' }, { status: 400 })
    }

    const client = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } })
    const clientEmail = client?.email.toLowerCase()
    const relationship =
      client
        ? await prisma.invoice.findFirst({
            where: { userId: user.id, OR: [{ clientId: client.id }, { clientEmail }] },
            select: { id: true },
          })
        : null
    if (!client || !clientEmail || !relationship) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const now = new Date()
    const signals = await loadClientPaymentSignals(clientEmail, now)
    const hasHistory = signals.onTime + signals.late + signals.disputed > 0
    const score = hasHistory ? calculateClientReputation(signals) : NEUTRAL_CLIENT_REPUTATION
    const reputation = await saveClientReputation(clientEmail, score, now)

    return NextResponse.json({
      clientId: client.id,
      reputation: reputation.paymentScore,
      hasHistory,
      lastCheckedAt: reputation.lastCheckedAt,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/clients/[id]/reputation error')
    return NextResponse.json({ error: 'Failed to fetch client reputation' }, { status: 500 })
  }
}
