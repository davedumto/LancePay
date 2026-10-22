import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { isValidStellarAddress } from '@/lib/stellar'
import { logger } from '@/lib/logger'
import {
  SIGNER_USER_SELECT,
  requireWalletActor,
  requireWalletSigner,
} from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string }> }

const DEFAULT_EXPIRY_HOURS = 72
const MAX_EXPIRY_HOURS = 7 * 24
/** Stellar text memos are limited to 28 bytes. */
const MAX_MEMO_BYTES = 28
/** amountUsdc is Decimal(18, 6): at most 12 integer digits and 6 fractional digits. */
const USDC_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,6})?$/
const LIST_LIMIT = 100

const createProposalSchema = z.object({
  destinationAddress: z.string().trim().min(1, 'destinationAddress is required'),
  amountUsdc: z.union([z.string().trim(), z.number()]),
  memo: z
    .string()
    .trim()
    .refine((m) => Buffer.byteLength(m, 'utf8') <= MAX_MEMO_BYTES, `memo must be at most ${MAX_MEMO_BYTES} bytes`)
    .optional(),
  expiresInHours: z
    .number()
    .int('expiresInHours must be an integer')
    .min(1)
    .max(MAX_EXPIRY_HOURS)
    .default(DEFAULT_EXPIRY_HOURS),
})

const PROPOSAL_SELECT = {
  id: true,
  walletId: true,
  destinationAddress: true,
  amountUsdc: true,
  memo: true,
  status: true,
  expiresAt: true,
  executedAt: true,
  stellarTxHash: true,
  createdAt: true,
  proposer: { select: SIGNER_USER_SELECT },
  _count: { select: { signatures: true } },
} as const

/** Returns a positive Decimal with at most 6 fractional digits, or null. */
function parseUsdcAmount(value: string | number): Prisma.Decimal | null {
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  const text = typeof value === 'number' ? String(value) : value
  if (!USDC_AMOUNT_PATTERN.test(text)) return null
  const amount = new Prisma.Decimal(text)
  return amount.gt(0) ? amount : null
}

/**
 * GET /api/collective-wallets/[id]/proposals
 * List the wallet's proposals, newest first. Optional ?status= filter.
 * Only signers of the wallet may view them.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id } = await params
    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response

    const status = request.nextUrl.searchParams.get('status')?.trim()
    if (status && status.length > 20) {
      return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 })
    }

    const proposals = await prisma.multisigProposal.findMany({
      where: { walletId: id, ...(status ? { status } : {}) },
      select: PROPOSAL_SELECT,
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    })

    return NextResponse.json({ proposals, threshold: access.wallet.threshold })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/collective-wallets/[id]/proposals error')
    return NextResponse.json({ error: 'Failed to fetch proposals' }, { status: 500 })
  }
}

/**
 * POST /api/collective-wallets/[id]/proposals
 * Create a pending payment proposal awaiting signatures. Only wallet signers may propose.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id } = await params
    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response
    const { wallet } = access

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createProposalSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }
    const { destinationAddress, memo, expiresInHours } = parsed.data

    const amountUsdc = parseUsdcAmount(parsed.data.amountUsdc)
    if (!amountUsdc) {
      return NextResponse.json(
        { error: 'amountUsdc must be a positive number with at most 6 decimal places' },
        { status: 400 }
      )
    }

    if (!isValidStellarAddress(destinationAddress)) {
      return NextResponse.json(
        { error: 'Invalid Stellar address. Must be a 56-character address starting with "G".' },
        { status: 400 }
      )
    }
    if (destinationAddress === wallet.stellarAddress) {
      return NextResponse.json(
        { error: 'destinationAddress cannot be the wallet itself' },
        { status: 400 }
      )
    }

    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000)

    const proposal = await prisma.multisigProposal.create({
      data: {
        walletId: wallet.id,
        proposerId: auth.actor.id,
        destinationAddress,
        amountUsdc,
        memo: memo || null,
        status: 'pending',
        expiresAt,
      },
      select: PROPOSAL_SELECT,
    })

    logger.info(
      { walletId: wallet.id, proposalId: proposal.id, proposerId: auth.actor.id },
      'Multisig proposal created'
    )

    return NextResponse.json({ proposal, threshold: wallet.threshold }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/collective-wallets/[id]/proposals error')
    return NextResponse.json({ error: 'Failed to create proposal' }, { status: 500 })
  }
}
