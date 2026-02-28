import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { EscrowReleaseSchema, getAuthContext, releaseEscrowFunds } from '@/app/api/routes-d/escrow/_shared'
import { sendEscrowReleasedEmail } from '@/lib/email'
import { processWaterfallPayments } from '@/lib/waterfall'
import { sendStellarPayment } from '@/lib/stellar'
import { Keypair } from '@stellar/stellar-sdk'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = EscrowReleaseSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })

    const { invoiceId, clientEmail, approvalNotes } = parsed.data

    if (clientEmail.toLowerCase() !== auth.email.toLowerCase()) {
      return NextResponse.json({ error: 'clientEmail must match authenticated user email' }, { status: 403 })
    }

    // Fetch invoice with collaborators using wallet relation (upstream schema pattern)
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        user: { include: { wallet: true } },
        collaborators: true,
      },
    })

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    if (invoice.clientEmail.toLowerCase() !== clientEmail.toLowerCase()) {
      return NextResponse.json({ error: 'Not authorized (client email mismatch)' }, { status: 403 })
    }

    if (!invoice.escrowEnabled) return NextResponse.json({ error: 'Escrow is not enabled for this invoice' }, { status: 400 })
    if (invoice.escrowStatus !== 'held') return NextResponse.json({ error: `Invalid escrow status: ${invoice.escrowStatus}` }, { status: 400 })

    // Pre-flight: validate all recipient wallets BEFORE touching on-chain state.
    // Prevents partial releases where some payments succeed and others fail.
    const freelancerWallet = invoice.user.wallet?.address
    if (!freelancerWallet) {
      return NextResponse.json({ error: 'Freelancer wallet address is not configured' }, { status: 422 })
    }

    const collaborators = invoice.collaborators ?? []
    for (const collaborator of collaborators) {
      if (!collaborator.walletAddress) {
        return NextResponse.json(
          { error: `Collaborator ${collaborator.email} does not have a wallet address configured` },
          { status: 422 }
        )
      }
      if (
        typeof collaborator.revenueSharePercent !== 'number' ||
        collaborator.revenueSharePercent <= 0 ||
        collaborator.revenueSharePercent >= 100
      ) {
        return NextResponse.json(
          { error: `Collaborator ${collaborator.email} has an invalid revenue share percentage` },
          { status: 422 }
        )
      }
    }

    const totalCollaboratorPercent: number = collaborators.reduce(
      (sum: number, c: any) => sum + c.revenueSharePercent,
      0
    )
    if (totalCollaboratorPercent >= 100) {
      return NextResponse.json(
        { error: 'Combined collaborator revenue shares meet or exceed 100%' },
        { status: 422 }
      )
    }

    const fundingSecret = process.env.STELLAR_FUNDING_WALLET_SECRET
    if (!fundingSecret) throw new Error('Funding secret not configured')
    const fundingKp = Keypair.fromSecret(fundingSecret)
    const fundingPublicKey = fundingKp.publicKey()

    const hasCollaborators = collaborators.length > 0
    const totalAmountUsdc = Number((invoice as any).escrowAmountUsdc ?? (invoice as any).totalAmount ?? invoice.amount)
    if (totalAmountUsdc <= 0) {
      return NextResponse.json({ error: 'Escrow amount is invalid or zero' }, { status: 422 })
    }

    const now = new Date()
    const result = await prisma.$transaction(async (tx) => {
      // Optimistic-concurrency: only succeeds if status is still 'held'
      const updateResult = await tx.invoice.updateMany({
        where: {
          id: invoice.id,
          escrowEnabled: true,
          escrowStatus: 'held',
          clientEmail: invoice.clientEmail,
        },
        data: {
          escrowStatus: 'released',
          status: 'paid',
          escrowReleasedAt: now,
        },
      })

      if (updateResult.count !== 1) {
        throw new Error('ESCROW_RELEASE_CONFLICT')
      }

      // On-chain release (Soroban escrow contract)
      if ((invoice as any).escrowContractId) {
        try {
          await releaseEscrowFunds((invoice as any).escrowContractId)
        } catch (err) {
          logger.error({ err }, 'On-chain escrow release failed:')
          throw new Error('Failed to release escrow on-chain. Please ensure you have sufficient XLM for gas.')
        }
      }

      await tx.escrowEvent.create({
        data: {
          invoiceId: invoice.id,
          eventType: 'released',
          actorType: 'client',
          actorEmail: clientEmail,
          notes: approvalNotes || 'Client approved work and released escrow',
        },
      })

      let distributions: any[] = []

      if (!hasCollaborators) {
        // No collaborators: full amount to freelancer
        await sendStellarPayment(
          fundingPublicKey,
          fundingSecret,
          freelancerWallet,
          totalAmountUsdc.toString(),
          `Escrow payout: ${(invoice as any).invoiceNumber}`
        )
      } else {
        // Waterfall: use processWaterfallPayments library
        const waterfallResult = await processWaterfallPayments(invoice.id, totalAmountUsdc, 'escrow')
        distributions = waterfallResult.distributions

        // Lead freelancer share first
        await sendStellarPayment(
          fundingPublicKey,
          fundingSecret,
          freelancerWallet,
          waterfallResult.leadShare.toString(),
          `Escrow lead share: ${(invoice as any).invoiceNumber}`
        )

        // Collaborator shares
        for (const dist of distributions) {
          if (dist.status === 'completed' && dist.walletAddress) {
            try {
              await sendStellarPayment(
                fundingPublicKey,
                fundingSecret,
                dist.walletAddress,
                dist.amount.toString(),
                `Revenue split: ${(invoice as any).invoiceNumber}`
              )
            } catch (err) {
              logger.error({ err, collaboratorEmail: dist.email }, `Failed to send payment to collaborator ${dist.email}:`)
            }
          }
        }

        // Audit log each collaborator payment
        for (const dist of distributions) {
          await tx.escrowEvent.create({
            data: {
              invoiceId: invoice.id,
              eventType: 'collaborator_payment_queued',
              actorType: 'system',
              actorEmail: dist.email,
              notes: `Queued ${dist.amount} USDC to collaborator ${dist.email}`,
            },
          })
        }
      }

      return {
        distributions,
        updatedInvoice: await tx.invoice.findUnique({
          where: { id: invoice.id },
          select: { id: true, escrowStatus: true, escrowReleasedAt: true },
        }),
      }
    })

    if (invoice.user.email) {
      await sendEscrowReleasedEmail({
        to: invoice.user.email,
        invoiceNumber: (invoice as any).invoiceNumber,
        clientEmail,
        notes: approvalNotes,
      })
    }

    return NextResponse.json({
      success: true,
      message: hasCollaborators
        ? `Escrow released with waterfall to ${collaborators.length} collaborators`
        : 'Escrow released to freelancer',
      invoice: {
        id: result.updatedInvoice?.id,
        escrowStatus: 'released',
        escrowReleasedAt: result.updatedInvoice?.escrowReleasedAt?.toISOString() ?? now.toISOString(),
      },
      distributions: result.distributions,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'ESCROW_RELEASE_CONFLICT') {
      return NextResponse.json({ error: 'Escrow status changed. Please refresh and retry.' }, { status: 409 })
    }
    logger.error({ err: error }, 'Escrow release error:')
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to release escrow' }, { status: 500 })
  }
}
