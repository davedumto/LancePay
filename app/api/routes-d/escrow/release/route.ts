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

    // Prevent spoofing
    if (clientEmail.toLowerCase() !== auth.email.toLowerCase()) {
      return NextResponse.json({ error: 'clientEmail must match authenticated user email' }, { status: 403 })
    }

    // Update query to include collaborators and user wallet
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

    const fundingSecret = process.env.STELLAR_FUNDING_WALLET_SECRET;
    if (!fundingSecret) throw new Error('Funding secret not configured');
    const fundingKp = Keypair.fromSecret(fundingSecret);
    const fundingPublicKey = fundingKp.publicKey();

    const hasCollaborators = invoice.collaborators.length > 0;
    const amountUsdc = Number(invoice.amount);

    const now = new Date()
    const result = await prisma.$transaction(async (tx) => {
      // 1. Escrow status update and invoice status update
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

      // 2. On-chain Release (Soroban)
      if (invoice.escrowContractId) {
        try {
          await releaseEscrowFunds(invoice.escrowContractId)
        } catch (err) {
          logger.error({ err }, 'On-chain escrow release failed:')
          throw new Error('Failed to release escrow on-chain. Please ensure you have sufficient XLM for gas.')
        }
      }

      // 3. Create Escrow Event
      await tx.escrowEvent.create({
        data: {
          invoiceId: invoice.id,
          eventType: 'released',
          actorType: 'client',
          actorEmail: clientEmail,
          notes: approvalNotes || 'Client approved work and released escrow',
        },
      })

      let distributions = [];

      // 4. Stellar Payments
      if (!hasCollaborators) {
        // Scenario A — No collaborators
        const freelancerWallet = invoice.user.wallet?.address;
        if (!freelancerWallet) throw new Error('Freelancer wallet not found');

        await sendStellarPayment(
          fundingPublicKey,
          fundingSecret,
          freelancerWallet,
          amountUsdc.toString(),
          `Escrow payout: ${invoice.invoiceNumber}`
        )
      } else {
        // Scenario B — Collaborators exist
        const waterfallResult = await processWaterfallPayments(invoice.id, amountUsdc, 'escrow');
        distributions = waterfallResult.distributions;

        const freelancerWallet = invoice.user.wallet?.address;
        if (!freelancerWallet) throw new Error('Freelancer wallet not found');

        // Send lead share to freelancer
        await sendStellarPayment(
          fundingPublicKey,
          fundingSecret,
          freelancerWallet,
          waterfallResult.leadShare.toString(),
          `Escrow lead share: ${invoice.invoiceNumber}`
        )

        // Loop distributions — send completed payments
        for (const dist of waterfallResult.distributions) {
          if (dist.status === 'completed' && dist.walletAddress) {
            try {
              await sendStellarPayment(
                fundingPublicKey,
                fundingSecret,
                dist.walletAddress,
                dist.amount.toString(),
                `Revenue split: ${invoice.invoiceNumber}`
              )
            } catch (err) {
              // Failed distributions are skipped in the payment loop — no throw
              logger.error({ err, collaboratorEmail: dist.email }, `Failed to send payment to collaborator ${dist.email}:`);
            }
          }
        }
      }

      return { distributions };
    })

    if (invoice.user.email) {
      await sendEscrowReleasedEmail({
        to: invoice.user.email,
        invoiceNumber: invoice.invoiceNumber,
        clientEmail,
        notes: approvalNotes,
      })
    }

    return NextResponse.json({
      success: true,
      message: hasCollaborators
        ? `Escrow released with waterfall to ${invoice.collaborators.length} collaborators`
        : 'Escrow released to freelancer',
      distributions: result.distributions
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'ESCROW_RELEASE_CONFLICT') {
      return NextResponse.json({ error: 'Escrow status changed. Please refresh and retry.' }, { status: 409 })
    }
    logger.error({ err: error }, 'Escrow release error:')
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to release escrow' }, { status: 500 })
  }
}
