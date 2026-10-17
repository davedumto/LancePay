import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { Account, MuxedAccount, StrKey } from '@stellar/stellar-sdk'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const RESERVED_PREFIXES = [
  'sys:',
  'sys_',
  'system:',
  'system_',
  'platform:',
  'platform_',
  'internal:',
  'internal_',
  'escrow:',
  'escrow_',
  'treasury:',
  'treasury_',
  'admin:',
  'admin_',
  'reserve:',
  'reserve_',
  'fee:',
  'fee_',
  'lancepay:',
  'lancepay_',
  '__',
] as const

const RESERVED_EXACT_LABELS = new Set([
  'sys',
  'system',
  'platform',
  'internal',
  'escrow',
  'treasury',
  'admin',
  'reserve',
  'fee',
  'lancepay',
  'root',
  'default',
])

// Reserve the lowest 1,000,000 IDs for internal protocol operations
const MIN_USER_MUXED_ID = BigInt(1_000_000)
const MAX_UINT64 = BigInt('18446744073709551615')
const USER_MUXED_SPAN = MAX_UINT64 - MIN_USER_MUXED_ID

export function isReservedMuxedLabel(rawLabel: string): boolean {
  const normalized = rawLabel.trim().toLowerCase()
  if (!normalized) return true
  if (RESERVED_EXACT_LABELS.has(normalized)) return true
  return RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * Deterministically derives a 64-bit unsigned muxed ID in [MIN_USER_MUXED_ID, MAX_UINT64]
 * from the parent Stellar G-address and the normalized label.
 */
export function deriveMuxedId(parentAccount: string, label: string): string {
  const normalized = label.trim().toLowerCase()
  const digest = crypto
    .createHash('sha256')
    .update(`lancepay:muxed:v1:${parentAccount}:${normalized}`)
    .digest()

  const rawUint64 = digest.readBigUInt64BE(0)
  const mappedId = MIN_USER_MUXED_ID + (rawUint64 % USER_MUXED_SPAN)
  return mappedId.toString(10)
}

export function encodeMuxedAddress(
  parentAccount: string,
  muxedId: string,
): string {
  const baseAccount = new Account(parentAccount, '0')
  const muxed = new MuxedAccount(baseAccount, muxedId)
  return muxed.accountId()
}

async function resolveAuthenticatedUserAndWallet(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  if (!token) return null

  const claims = await verifyAuthToken(token)
  if (!claims) return null

  let userId = claims.userId
  let walletAddress: string | null = null

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: {
        id: true,
        wallet: { select: { address: true } },
      },
    })
    if (dbUser) {
      userId = dbUser.id
      walletAddress = dbUser.wallet?.address ?? null
    }
  }

  if (!walletAddress && typeof prisma.wallet?.findUnique === 'function') {
    const wallet = await prisma.wallet.findUnique({
      where: { userId },
      select: { address: true },
    })
    walletAddress = wallet?.address ?? null
  }

  return { userId, walletAddress }
}

/**
 * GET /api/stellar/muxed-accounts/derive
 * Deterministically derives a Stellar CAP-0027 muxed account (M...) for a user's
 * wallet and a given sub-account label while rejecting reserved platform namespaces.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUserAndWallet(req)
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const rawLabel = searchParams.get('label') ?? ''
    const label = rawLabel.trim()

    if (!label) {
      return NextResponse.json(
        { error: 'label query parameter is required' },
        { status: 400 },
      )
    }

    if (label.length > 128) {
      return NextResponse.json(
        { error: 'label must be at most 128 characters' },
        { status: 400 },
      )
    }

    if (isReservedMuxedLabel(label)) {
      return NextResponse.json(
        {
          error:
            'Label collides with an internal reserved namespace and cannot be used',
          code: 'RESERVED_MUXED_NAMESPACE',
        },
        { status: 422 },
      )
    }

    const parentAccount =
      searchParams.get('parentAccount')?.trim() || auth.walletAddress || ''

    if (!parentAccount) {
      return NextResponse.json(
        { error: 'User does not have a provisioned Stellar wallet' },
        { status: 404 },
      )
    }

    if (
      auth.walletAddress &&
      parentAccount !== auth.walletAddress
    ) {
      return NextResponse.json(
        { error: 'Forbidden: parentAccount does not match user wallet' },
        { status: 403 },
      )
    }

    if (!StrKey.isValidEd25519PublicKey(parentAccount)) {
      return NextResponse.json(
        { error: 'Invalid parent Stellar Ed25519 public key' },
        { status: 400 },
      )
    }

    const normalizedLabel = label.toLowerCase()
    const muxedId = deriveMuxedId(parentAccount, normalizedLabel)
    const muxedAddress = encodeMuxedAddress(parentAccount, muxedId)

    return NextResponse.json({
      muxedAddress,
      parentAccount,
      muxedId,
      label,
      normalizedLabel,
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/stellar/muxed-accounts/derive error')
    return NextResponse.json(
      { error: 'Failed to derive Stellar muxed account' },
      { status: 500 },
    )
  }
}
