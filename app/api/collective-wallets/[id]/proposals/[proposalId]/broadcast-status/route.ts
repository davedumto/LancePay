import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const ALLOWED_BROADCAST_STATUSES = new Set([
  'pending',
  'confirmed',
  'failed',
] as const)

type RouteContext = {
  params:
    | Promise<{ id: string; proposalId: string }>
    | { id: string; proposalId: string }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

async function resolveRouteParams(context?: RouteContext) {
  if (!context?.params) return { walletId: '', proposalId: '' }
  const resolved = await Promise.resolve(context.params)
  return {
    walletId: (resolved?.id ?? '').trim(),
    proposalId: (resolved?.proposalId ?? '').trim(),
  }
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }

  const actor =
    (await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, email: true },
    })) ??
    (await prisma.user.findUnique({
      where: { id: claims.userId },
      select: { id: true, email: true },
    }))

  if (!actor) {
    return { error: 'User not found', status: 404 as const, actor: null }
  }

  return { error: null, status: 200 as const, actor }
}

async function authorizeProposalSigner(
  walletId: string,
  proposalId: string,
  actorId: string,
) {
  const wallet = await prisma.collectiveWallet.findUnique({
    where: { id: walletId },
    include: { signers: true },
  })

  if (!wallet) {
    return {
      error: 'Collective wallet not found',
      code: 'WALLET_NOT_FOUND',
      status: 404 as const,
      wallet: null,
      proposal: null,
    }
  }

  const isSigner = (wallet.signers ?? []).some(
    (s: { userId: string }) => s.userId === actorId,
  )
  if (!isSigner) {
    return {
      error:
        'Forbidden: only wallet signers on this collective wallet may access proposal broadcast status',
      code: 'NOT_A_SIGNER',
      status: 403 as const,
      wallet: null,
      proposal: null,
    }
  }

  const proposal = await prisma.multisigProposal.findUnique({
    where: { id: proposalId },
    include: { broadcast: true },
  })

  if (!proposal || proposal.walletId !== wallet.id) {
    return {
      error: 'Multisig proposal not found in this collective wallet',
      code: 'PROPOSAL_NOT_FOUND',
      status: 404 as const,
      wallet: null,
      proposal: null,
    }
  }

  return {
    error: null,
    code: null,
    status: 200 as const,
    wallet,
    proposal,
  }
}

function formatBroadcastPayload(record: Record<string, any>) {
  const rawStatus = String(record.status ?? 'pending').toLowerCase()
  const hasConfirmedAt =
    record.confirmedAt !== null && record.confirmedAt !== undefined

  let effectiveStatus: 'pending' | 'confirmed' | 'failed'
  if (rawStatus === 'failed') {
    effectiveStatus = 'failed'
  } else if (hasConfirmedAt && rawStatus === 'confirmed') {
    effectiveStatus = 'confirmed'
  } else if (hasConfirmedAt) {
    effectiveStatus = 'confirmed'
  } else {
    effectiveStatus = 'pending'
  }

  const confirmedAtIso = hasConfirmedAt
    ? new Date(record.confirmedAt).toISOString()
    : null
  const broadcastAtIso = record.broadcastAt
    ? new Date(record.broadcastAt).toISOString()
    : null
  const failureReason =
    effectiveStatus === 'failed'
      ? (typeof record.failureReason === 'string' &&
          record.failureReason.trim()) ||
        'Transaction broadcast failed on network'
      : null

  return {
    id: record.id,
    proposalId: record.proposalId,
    txHash: record.txHash ?? null,
    network: record.network ?? 'stellar',
    status: effectiveStatus,
    isConfirmed: effectiveStatus === 'confirmed' && confirmedAtIso !== null,
    isPending: effectiveStatus === 'pending' && confirmedAtIso === null,
    isFailed: effectiveStatus === 'failed',
    broadcastAt: broadcastAtIso,
    confirmedAt: confirmedAtIso,
    failureReason,
  }
}

/**
 * GET /api/collective-wallets/[id]/proposals/[proposalId]/broadcast-status
 * Reads broadcast confirmation state (`MultisigBroadcast`) for a multisig proposal:
 * - Restricts visibility to wallet signers on the underlying proposal.
 * - Distinguishes `pending` from `confirmed` using `confirmedAt`, and surfaces `failureReason` when `status` is `failed`.
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.actor) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { walletId, proposalId } = await resolveRouteParams(context)
    if (!walletId || !proposalId) {
      return NextResponse.json(
        { error: 'Wallet ID and proposal ID are required' },
        { status: 400 },
      )
    }

    const access = await authorizeProposalSigner(
      walletId,
      proposalId,
      auth.actor.id,
    )
    if (access.error || !access.proposal) {
      return NextResponse.json(
        { error: access.error, code: access.code },
        { status: access.status },
      )
    }

    const broadcastRecord =
      access.proposal.broadcast ??
      (typeof prisma.multisigBroadcast?.findUnique === 'function'
        ? await prisma.multisigBroadcast.findUnique({
            where: { proposalId: access.proposal.id },
          })
        : null)

    if (!broadcastRecord) {
      return NextResponse.json(
        {
          error: 'No broadcast record exists for this proposal yet',
          code: 'BROADCAST_NOT_FOUND',
        },
        { status: 404 },
      )
    }

    const formatted = formatBroadcastPayload(broadcastRecord)
    return NextResponse.json({
      broadcast: formatted,
      status: formatted.status,
      confirmedAt: formatted.confirmedAt,
      failureReason: formatted.failureReason,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'GET /api/collective-wallets/[id]/proposals/[proposalId]/broadcast-status error',
    )
    return NextResponse.json(
      { error: 'Failed to fetch multisig broadcast status' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/collective-wallets/[id]/proposals/[proposalId]/broadcast-status
 * Creates the `MultisigBroadcast` record for a proposal:
 * - Enforces the unique `proposalId` constraint (only one broadcast record per proposal, returning 409 on duplicate).
 * - Restricts creation to wallet signers on the underlying proposal.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.actor) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { walletId, proposalId } = await resolveRouteParams(context)
    if (!walletId || !proposalId) {
      return NextResponse.json(
        { error: 'Wallet ID and proposal ID are required' },
        { status: 400 },
      )
    }

    const access = await authorizeProposalSigner(
      walletId,
      proposalId,
      auth.actor.id,
    )
    if (access.error || !access.proposal) {
      return NextResponse.json(
        { error: access.error, code: access.code },
        { status: access.status },
      )
    }

    const body = await req.json().catch(() => ({}))
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    const rawStatus =
      typeof body.status === 'string'
        ? body.status.trim().toLowerCase()
        : 'pending'
    if (
      !ALLOWED_BROADCAST_STATUSES.has(
        rawStatus as 'pending' | 'confirmed' | 'failed',
      )
    ) {
      return NextResponse.json(
        {
          error: 'status must be one of: pending, confirmed, failed',
          code: 'INVALID_BROADCAST_STATUS',
        },
        { status: 400 },
      )
    }

    if (
      access.proposal.broadcast ||
      (typeof prisma.multisigBroadcast?.findUnique === 'function' &&
        (await prisma.multisigBroadcast.findUnique({
          where: { proposalId: access.proposal.id },
        })))
    ) {
      return NextResponse.json(
        {
          error: 'A broadcast record already exists for this proposal',
          code: 'BROADCAST_ALREADY_EXISTS',
        },
        { status: 409 },
      )
    }

    const txHash =
      typeof body.txHash === 'string' && body.txHash.trim()
        ? body.txHash.trim()
        : null
    const network =
      typeof body.network === 'string' && body.network.trim()
        ? body.network.trim()
        : 'stellar'
    const confirmedAt =
      rawStatus === 'confirmed'
        ? body.confirmedAt
          ? new Date(body.confirmedAt)
          : new Date()
        : null
    const failureReason =
      rawStatus === 'failed'
        ? (typeof body.failureReason === 'string' &&
            body.failureReason.trim()) ||
          'Transaction broadcast failed on network'
        : null

    let created
    try {
      created = await prisma.multisigBroadcast.create({
        data: {
          proposalId: access.proposal.id,
          txHash,
          network,
          status: rawStatus,
          confirmedAt,
          failureReason,
        },
      })
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return NextResponse.json(
          {
            error: 'A broadcast record already exists for this proposal',
            code: 'BROADCAST_ALREADY_EXISTS',
          },
          { status: 409 },
        )
      }
      throw err
    }

    const formatted = formatBroadcastPayload(created)
    return NextResponse.json(
      {
        broadcast: formatted,
        status: formatted.status,
        confirmedAt: formatted.confirmedAt,
        failureReason: formatted.failureReason,
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.(
      { err },
      'POST /api/collective-wallets/[id]/proposals/[proposalId]/broadcast-status error',
    )
    return NextResponse.json(
      { error: 'Failed to create multisig broadcast record' },
      { status: 500 },
    )
  }
}
