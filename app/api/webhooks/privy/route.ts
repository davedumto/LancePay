import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { fundNewWallet } from '@/lib/stellar-funding'
import { sendAdminAlertEmail } from '@/lib/email'
import { Prisma } from '@prisma/client'
import { logger } from '@/lib/logger'

type PrivyLinkedAccount = {
  type?: string
  address?: string
  wallet_client_type?: string
  walletClientType?: string
}

type PrivyUserData = {
  id?: string
  email?: {
    address?: string
  }
  linked_accounts?: PrivyLinkedAccount[]
}

type PrivyEventData = {
  user?: PrivyUserData
  id?: string
  email?: {
    address?: string
  }
  linked_accounts?: PrivyLinkedAccount[]
  linked_account?: PrivyLinkedAccount
}

type PrivyEvent = {
  type?: string
  data?: PrivyEventData
}

type FundingContext = {
  eventType: string
  privyId: string
  destination: string
}

type UserCreatedExtract = {
  privyId: string
  email: string
  linkedAccounts: PrivyLinkedAccount[]
}

type LinkedAccountExtract = {
  privyId: string
  linkedAccount: PrivyLinkedAccount
}

function parseJsonSafely(text: string): { ok: true; value: PrivyEvent } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' }
  }
}

function isPrivyEmbeddedWallet(account: PrivyLinkedAccount): boolean {
  return (
    account?.type === 'wallet' &&
    (account?.wallet_client_type === 'privy' || account?.walletClientType === 'privy')
  )
}

function extractUserCreated(event: PrivyEvent): UserCreatedExtract | null {
  const userData = event.data?.user || event.data
  const privyId = userData?.id
  if (!privyId || typeof privyId !== 'string') return null

  const email = userData?.email?.address && typeof userData.email.address === 'string'
    ? userData.email.address
    : ''

  const linkedAccounts = Array.isArray(userData?.linked_accounts) ? userData.linked_accounts : []
  return { privyId, email, linkedAccounts }
}

function extractLinkedAccount(event: PrivyEvent): LinkedAccountExtract | null {
  const userData = event.data?.user || event.data
  const privyId = userData?.id
  if (!privyId || typeof privyId !== 'string') return null

  const linkedAccount = event.data?.linked_account
  if (!linkedAccount) return null

  return { privyId, linkedAccount }
}

function extractWalletAddressFromLinkedAccounts(linkedAccounts: PrivyLinkedAccount[]): string | null {
  const embeddedWallet = linkedAccounts.find((a: PrivyLinkedAccount) => isPrivyEmbeddedWallet(a))
  const addr = embeddedWallet?.address
  return typeof addr === 'string' && addr.length > 0 ? addr : null
}

function extractWalletAddressFromLinkedAccount(linkedAccount: PrivyLinkedAccount): string | null {
  const addr = linkedAccount?.address
  return typeof addr === 'string' && addr.length > 0 ? addr : null
}

function isUniqueConstraintError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

/**
 * Execute wallet funding and handle alert notifications.
 * Alert failures are logged but do not break webhook processing.
 */
async function runFundingAndAlerts(ctx: FundingContext): Promise<void> {
  const result = await fundNewWallet(ctx.destination)

  if (result.status === 'funded') {
    logger.info({
      eventType: ctx.eventType,
      privyId: ctx.privyId,
      destination: ctx.destination,
      txHash: result.txHash,
    }, 'Stellar wallet funded')
  } else if (result.status === 'skipped') {
    logger.info({
      eventType: ctx.eventType,
      privyId: ctx.privyId,
      destination: ctx.destination,
      reason: result.reason,
    }, 'Stellar wallet funding skipped')
  } else {
    logger.error({
      eventType: ctx.eventType,
      privyId: ctx.privyId,
      destination: ctx.destination,
      reason: result.reason,
    }, 'Stellar wallet funding failed')

    // Send alert for funding failures 
    try {
      await sendAdminAlertEmail({
        subject: '[LancePay] Stellar wallet funding failed',
        message: 'A Stellar wallet funding attempt failed. Review context and take action if needed.',
        context: {
          eventType: ctx.eventType,
          privyId: ctx.privyId,
          destination: ctx.destination,
          reason: result.reason ?? 'unknown',
        },
      })
    } catch (err) {
      logger.error({
        eventType: ctx.eventType,
        privyId: ctx.privyId,
        destination: ctx.destination,
        err,
      }, 'Admin alert email failed (non-blocking)')
    }
  }

  if (result.lowBalance) {
    logger.error({
      eventType: ctx.eventType,
      privyId: ctx.privyId,
      destination: ctx.destination,
      impact: 'Funding wallet below threshold',
    }, 'Stellar funding wallet balance low')

    // Send alert for low balance 
    try {
      await sendAdminAlertEmail({
        subject: '[LancePay] Stellar funding wallet balance low',
        message:
          'The Stellar funding wallet is below the configured threshold. Refill the funding wallet to avoid failed user fundings.',
        context: {
          eventType: ctx.eventType,
          privyId: ctx.privyId,
          lastDestinationAttempt: ctx.destination,
          impact: 'Funding wallet below threshold',
        },
      })
    } catch (err) {
      logger.error({
        eventType: ctx.eventType,
        privyId: ctx.privyId,
        destination: ctx.destination,
        err,
      }, 'Admin alert email failed (non-blocking)')
    }
  }
}

/**
 * Handle user.created event:
 * - Create User record if not exists
 * - Create Wallet record when embedded wallet address is present
 * - Fund wallet address (idempotent operation)
 */
async function handleUserCreated(event: PrivyEvent): Promise<void> {
  const extracted = extractUserCreated(event)
  if (!extracted) {
    logger.warn('user.created: missing privyId; skipping')
    return
  }

  const { privyId, email, linkedAccounts } = extracted
  const walletAddress = extractWalletAddressFromLinkedAccounts(linkedAccounts)

  logger.info({ privyId, hasEmail: Boolean(email), hasWallet: Boolean(walletAddress) }, 'user.created received')

  // Use a transaction so concurrent webhooks don't create duplicate users.
  let user = null as null | { id: string; privyId: string; email: string }

  try {
    user = await prisma.$transaction(async (tx: any) => {
      const existing = await tx.user.findUnique({ where: { privyId } })
      if (existing) return existing

      return tx.user.create({
        data: {
          privyId,
          email: email || `${privyId}@privy.local`,
        },
      })
    })
  } catch (e) {
    // Handle concurrent creation attempts by fetching existing user
    if (isUniqueConstraintError(e)) {
      user = await prisma.user.findUnique({ where: { privyId } })
    } else {
      throw e
    }
  }

  if (!user) {
    logger.error({ privyId }, 'user.created: user resolution failed unexpectedly')
    return
  }

  // Create or update wallet record when address is present
  if (walletAddress) {
    try {
      await prisma.wallet.upsert({
        where: { userId: user.id },
        create: { userId: user.id, address: walletAddress },
        update: { address: walletAddress },
      })
    } catch (e) {
      // Concurrent wallet creation handled as idempotent operation
      if (!isUniqueConstraintError(e)) throw e
    }

    // Execute funding (idempotent on-chain via createAccount operation)
    await runFundingAndAlerts({
      eventType: event.type || 'user.created',
      privyId,
      destination: walletAddress,
    })
  }
}

/**
 * Handle user.linked_account event:
 * - Create Wallet record for embedded Privy wallet
 * - Fund wallet address (idempotent operation)
 */
async function handleLinkedAccount(event: PrivyEvent): Promise<void> {
  const extracted = extractLinkedAccount(event)
  if (!extracted) {
    logger.warn('user.linked_account: missing required fields; skipping')
    return
  }

  const { privyId, linkedAccount } = extracted
  const isEmbedded = isPrivyEmbeddedWallet(linkedAccount)
  const walletAddress = extractWalletAddressFromLinkedAccount(linkedAccount)

  logger.info({
    privyId,
    isEmbeddedWallet: isEmbedded,
    hasWalletAddress: Boolean(walletAddress),
  }, 'user.linked_account received')

  if (!isEmbedded || !walletAddress) return

  const user = await prisma.user.findUnique({ where: { privyId }, include: { wallet: true } })
  if (!user) {
    logger.warn({ privyId }, 'user.linked_account: user not found; skipping')
    return
  }

  // Create or update wallet record
  try {
    if (!user.wallet) {
      await prisma.wallet.create({
        data: { userId: user.id, address: walletAddress },
      })
    } else if (user.wallet.address !== walletAddress) {
      await prisma.wallet.update({
        where: { userId: user.id },
        data: { address: walletAddress },
      })
    }
  } catch (e) {
    // Concurrent wallet creation handled as idempotent operation
    if (!isUniqueConstraintError(e)) throw e
  }

  await runFundingAndAlerts({
    eventType: event.type || 'user.linked_account',
    privyId,
    destination: walletAddress,
  })
}

/**
 * Handle user.wallet_created event (optional):
 * Supports future Privy event type by reusing existing extraction logic.
 */
async function handleUserWalletCreated(event: PrivyEvent): Promise<void> {
  // Attempt linked_account payload structure
  const extracted = extractLinkedAccount(event)
  if (extracted) {
    await handleLinkedAccount({ ...event, type: 'user.wallet_created' })
    return
  }

  // Fallback to user_created payload structure
  const uc = extractUserCreated(event)
  if (uc) {
    await handleUserCreated({ ...event, type: 'user.wallet_created' })
    return
  }

  logger.warn('user.wallet_created: unsupported payload shape; skipping')
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.text()
    const parsed = parseJsonSafely(body)

    if (!parsed.ok) {
      logger.error({ err: parsed.error }, 'Privy webhook: invalid JSON')
      return NextResponse.json({ received: true })
    }

    const event = parsed.value as PrivyEvent
    const eventType = typeof event?.type === 'string' ? event.type : 'unknown'

    logger.info({ eventType, event }, 'Privy webhook received')

    if (eventType === 'privy.test') {
      logger.info('Test event received, ignoring')
      return NextResponse.json({ received: true })
    }

    if (eventType === 'user.created') {
      await handleUserCreated(event)
      return NextResponse.json({ received: true })
    }

    if (eventType === 'user.linked_account') {
      await handleLinkedAccount(event)
      return NextResponse.json({ received: true })
    }

    // Support for future user.wallet_created event 
    if (eventType === 'user.wallet_created') {
      await handleUserWalletCreated(event)
      return NextResponse.json({ received: true })
    }

    logger.info({ eventType }, 'Privy webhook: unhandled event type; ignoring')
    return NextResponse.json({ received: true })
  } catch (error) {
    logger.error({ err: error }, 'Privy webhook error')
    return NextResponse.json({ received: true })
  }
}