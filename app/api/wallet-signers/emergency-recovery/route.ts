import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum number of distinct admin approvals required before the recovery can
 * be acted on.  A single admin cannot unilaterally override wallet quorum.
 */
export const MIN_APPROVALS = 2

/**
 * How long (ms) the recovery request stays open for approvals before it
 * automatically expires and must be re-initiated.
 */
const RECOVERY_TTL_MS = 72 * 60 * 60 * 1000 // 72 hours

/** Minimum characters required in the justification field. */
const MIN_JUSTIFICATION_LENGTH = 20

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Count how many signers on the wallet are currently "active" — i.e. have a
 * WalletSigner row (the schema does not track online/offline state, so we
 * define "active" as simply having a signer record, matching the real schema).
 * Quorum is broken when the active count is strictly less than the threshold.
 */
function isQuorumBroken(activeSigners: number, threshold: number): boolean {
  return activeSigners < threshold
}

// ── POST /api/wallet-signers/emergency-recovery ───────────────────────────────
export async function POST(request: NextRequest) {
  try {
    // ── 1. Auth ───────────────────────────────────────────────────────────────
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // ── 2. Admin-only gate ────────────────────────────────────────────────────
    if (user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 })
    }

    // ── 3. Parse & validate body ──────────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { walletId, justification } = body as Record<string, unknown>

    if (!walletId || typeof walletId !== 'string' || walletId.trim() === '') {
      return NextResponse.json({ error: 'walletId is required' }, { status: 400 })
    }

    if (
      !justification ||
      typeof justification !== 'string' ||
      justification.trim().length < MIN_JUSTIFICATION_LENGTH
    ) {
      return NextResponse.json(
        {
          error: `justification is required and must be at least ${MIN_JUSTIFICATION_LENGTH} characters`,
        },
        { status: 400 },
      )
    }

    // ── 4. Load wallet and verify quorum is actually broken ───────────────────
    const wallet = await prisma.collectiveWallet.findUnique({
      where: { id: walletId.trim() },
      include: {
        signers: { select: { userId: true } },
      },
    })

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
    }

    const signerCount = wallet.signers.length
    const threshold = wallet.threshold
    const activeSignerCount = signerCount // all signer rows count as active per schema

    if (!isQuorumBroken(activeSignerCount, threshold)) {
      return NextResponse.json(
        {
          error:
            'Wallet quorum is not broken: emergency recovery can only be initiated when active signers fall below the threshold',
          details: { activeSignerCount, threshold },
        },
        { status: 409 },
      )
    }

    // ── 5. Prevent duplicate open requests for the same wallet ─────────────────
    const existing = await prisma.emergencyRecovery.findFirst({
      where: {
        walletId: walletId.trim(),
        status: { in: ['pending', 'approved'] },
        expiresAt: { gt: new Date() },
      },
    })

    if (existing) {
      return NextResponse.json(
        {
          error: 'An active emergency recovery request already exists for this wallet',
          existingRecoveryId: existing.id,
        },
        { status: 409 },
      )
    }

    // ── 6. Create the recovery record ─────────────────────────────────────────
    const expiresAt = new Date(Date.now() + RECOVERY_TTL_MS)

    const recovery = await prisma.emergencyRecovery.create({
      data: {
        walletId: walletId.trim(),
        initiatorId: user.id,
        justification: justification.trim(),
        status: 'pending',
        signerCountAtRequest: signerCount,
        thresholdAtRequest: threshold,
        activeSignerCount,
        expiresAt,
      },
    })

    logger.error(
      {
        recoveryId: recovery.id,
        walletId: recovery.walletId,
        initiatorId: user.id,
        activeSignerCount,
        threshold,
      },
      'Emergency recovery initiated — requires multi-party admin approval',
    )

    return NextResponse.json(
      {
        recovery: {
          id: recovery.id,
          walletId: recovery.walletId,
          status: recovery.status,
          justification: recovery.justification,
          signerCountAtRequest: recovery.signerCountAtRequest,
          thresholdAtRequest: recovery.thresholdAtRequest,
          activeSignerCount: recovery.activeSignerCount,
          requiredApprovals: MIN_APPROVALS,
          approvalsReceived: 0,
          expiresAt: recovery.expiresAt,
          createdAt: recovery.createdAt,
        },
        message: `Emergency recovery initiated. Requires ${MIN_APPROVALS} admin approvals before it can be executed.`,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/wallet-signers/emergency-recovery error')
    return NextResponse.json({ error: 'Failed to initiate emergency recovery' }, { status: 500 })
  }
}
