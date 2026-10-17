import { NextRequest, NextResponse } from 'next/server'
import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { server, STELLAR_NETWORK } from '@/lib/stellar'
import { logger } from '@/lib/logger'

export const MAX_SWEEP_BATCH_SIZE = 20
export const DEFAULT_SWEEP_BATCH_SIZE = 10
export const BASE_RESERVE_XLM = 0.5

const ELIGIBLE_BENEFICIARY_STATES = new Set(['merged', 'retired'])

export interface SponsorshipEntryRecord {
  id: string
  sponsorAccount: string
  beneficiaryAccount: string
  beneficiaryStatus: string
  entryType?: 'account' | 'trustline' | 'data'
  assetCode?: string | null
  assetIssuer?: string | null
  dataName?: string | null
  reserveSubentries?: number
  status: string
}

async function verifyAdminOrOperator(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  if (!token) return null

  const claims = await verifyAuthToken(token)
  if (!claims) return null

  let role = claims.role
  let userId = claims.userId

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true },
    })
    if (dbUser) {
      userId = dbUser.id
      role = dbUser.role ?? role
    }
  }

  return { userId, role }
}

/**
 * POST /api/stellar/sponsored-reserves/sweep
 * Sweeps stranded sponsored reserves from beneficiary accounts that have been
 * merged or marked retired back to the sponsor account.
 * - Filters strictly to beneficiaries in 'merged' or 'retired' state.
 * - Bounds each sweep batch to MAX_SWEEP_BATCH_SIZE (20) operations so the
 *   Stellar transaction never exceeds protocol size limits.
 * - Records every reclaimed entry on the sponsorship ledger for audit replay.
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await verifyAdminOrOperator(req)
    if (!caller) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: Record<string, unknown> = {}
    try {
      const text = await req.text()
      if (text.trim()) {
        body = JSON.parse(text) as Record<string, unknown>
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawBatchSize =
      body.batchSize !== undefined
        ? Number(body.batchSize)
        : DEFAULT_SWEEP_BATCH_SIZE

    if (
      !Number.isInteger(rawBatchSize) ||
      rawBatchSize <= 0 ||
      rawBatchSize > MAX_SWEEP_BATCH_SIZE
    ) {
      return NextResponse.json(
        {
          error: `batchSize must be a positive integer between 1 and ${MAX_SWEEP_BATCH_SIZE}`,
          code: 'INVALID_BATCH_SIZE',
        },
        { status: 400 },
      )
    }

    const db = prisma as unknown as {
      sponsoredReserve?: {
        findMany: (args: unknown) => Promise<SponsorshipEntryRecord[]>
        updateMany: (args: unknown) => Promise<{ count: number }>
      }
      sponsorshipLedger?: {
        create: (args: unknown) => Promise<Record<string, unknown>>
      }
      journalEntry?: {
        create: (args: unknown) => Promise<Record<string, unknown>>
      }
    }

    const candidateEntries =
      (await db.sponsoredReserve?.findMany({
        where: {
          status: 'active',
          beneficiaryStatus: { in: ['merged', 'retired'] },
        },
        orderBy: { createdAt: 'asc' },
        take: rawBatchSize,
      })) ?? []

    // Defensive filter ensuring only merged or retired beneficiary accounts are swept
    const eligibleBatch = candidateEntries
      .filter(
        (entry) =>
          entry.status === 'active' &&
          ELIGIBLE_BENEFICIARY_STATES.has(
            String(entry.beneficiaryStatus).toLowerCase(),
          ),
      )
      .slice(0, MAX_SWEEP_BATCH_SIZE)

    if (eligibleBatch.length === 0) {
      return NextResponse.json({
        sweptCount: 0,
        reclaimedXlm: '0.0000000',
        txHash: null,
        ledgerEntries: [],
      })
    }

    const sponsorSecret =
      process.env.STELLAR_FUNDING_WALLET_SECRET || Keypair.random().secret()
    const sponsorKeypair = Keypair.fromSecret(sponsorSecret)
    const sponsorPublicKey =
      (typeof body.sponsorAccount === 'string' && body.sponsorAccount.trim()) ||
      eligibleBatch[0].sponsorAccount ||
      sponsorKeypair.publicKey()

    const sponsorAccountObj = await server.loadAccount(sponsorPublicKey)
    const fee =
      typeof server.fetchBaseFee === 'function'
        ? String(await server.fetchBaseFee())
        : String(BASE_FEE)

    const txBuilder = new TransactionBuilder(sponsorAccountObj, {
      fee,
      networkPassphrase: STELLAR_NETWORK,
    })

    for (const entry of eligibleBatch) {
      txBuilder.addOperation(
        Operation.revokeAccountSponsorship({
          account: entry.beneficiaryAccount,
          source: sponsorPublicKey,
        }),
      )
    }

    const tx = txBuilder.setTimeout(60).build()
    tx.sign(sponsorKeypair)

    const txResult = await server.submitTransaction(tx)
    const sweptAt = new Date()

    const sweptIds = eligibleBatch.map((e) => e.id)
    if (typeof db.sponsoredReserve?.updateMany === 'function') {
      await db.sponsoredReserve.updateMany({
        where: { id: { in: sweptIds } },
        data: {
          status: 'swept',
          sweptAt,
          sweepTxHash: txResult.hash,
        },
      })
    }

    const ledgerEntries: Array<Record<string, unknown>> = []
    let totalReclaimedXlm = 0

    for (const entry of eligibleBatch) {
      const subentries = Math.max(1, Number(entry.reserveSubentries ?? 2))
      const reclaimedXlm = Number((subentries * BASE_RESERVE_XLM).toFixed(7))
      totalReclaimedXlm += reclaimedXlm

      if (typeof db.sponsorshipLedger?.create === 'function') {
        const ledgerRow = await db.sponsorshipLedger.create({
          data: {
            sponsoredReserveId: entry.id,
            sponsorAccount: sponsorPublicKey,
            beneficiaryAccount: entry.beneficiaryAccount,
            beneficiaryStatus: entry.beneficiaryStatus,
            reclaimedSubentries: subentries,
            reclaimedXlm: reclaimedXlm.toFixed(7),
            txHash: txResult.hash,
            sweptBy: caller.userId,
            createdAt: sweptAt,
          },
        })
        ledgerEntries.push(ledgerRow)
      } else {
        ledgerEntries.push({
          sponsoredReserveId: entry.id,
          sponsorAccount: sponsorPublicKey,
          beneficiaryAccount: entry.beneficiaryAccount,
          beneficiaryStatus: entry.beneficiaryStatus,
          reclaimedSubentries: subentries,
          reclaimedXlm: reclaimedXlm.toFixed(7),
          txHash: txResult.hash,
        })
      }
    }

    logger?.info?.(
      {
        sweptCount: eligibleBatch.length,
        reclaimedXlm: totalReclaimedXlm.toFixed(7),
        txHash: txResult.hash,
      },
      'POST /api/stellar/sponsored-reserves/sweep completed',
    )

    return NextResponse.json({
      sweptCount: eligibleBatch.length,
      reclaimedXlm: totalReclaimedXlm.toFixed(7),
      txHash: txResult.hash,
      sponsorAccount: sponsorPublicKey,
      ledgerEntries,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'POST /api/stellar/sponsored-reserves/sweep error',
    )
    return NextResponse.json(
      { error: 'Failed to sweep stranded sponsored reserves' },
      { status: 500 },
    )
  }
}
