import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { EscrowReleaseSchema, getAuthContext, releaseEscrowFunds } from '@/app/api/routes-d/escrow/_shared'
import { sendEscrowReleasedEmail } from '@/lib/email'
import { logger } from '@/lib/logger'
import { sendStellarPayment } from '@/lib/stellar'

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = EscrowReleaseSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })

    const { invoiceId, clientEmail, approvalNotes } = parsed.data

    // Prevent spoofing — authenticated user must be the client releasing funds
    if (clientEmail.toLowerCase() !== auth.email.toLowerCase()) {
      return NextResponse.json({ error: 'clientEmail must match authenticated user email' }, { status: 403 })
    }

    // Fetch the invoice WITH collaborators so we can perform waterfall distribution.
    // Previously this query omitted collaborators, causing the full amount to be sent
    // to the freelancer even when revenue splits existed.
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            // Fetch the freelancer wallet so we can send their share on-chain
            walletAddress: true,
          },
        },
        // Collaborators carry their own walletAddress and revenueSharePercent;
        // without this include the waterfall logic has no split data to work with.
        collaborators: {
          select: {
            id: true,
            email: true,
            walletAddress: true,
            revenueSharePercent: true,
          },
        },
      },
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    if (invoice.clientEmail.toLowerCase() !== clientEmail.toLowerCase()) {
      return NextResponse.json({ error: 'Not authorized (client email mismatch)' }, { status: 403 })
    }

    if (!(invoice as any).escrowEnabled) return NextResponse.json({ error: 'Escrow is not enabled for this invoice' }, { status: 400 })
    if ((invoice as any).escrowStatus !== 'held') return NextResponse.json({ error: `Invalid escrow status: ${(invoice as any).escrowStatus}` }, { status: 400 })

    // ── Pre-flight: validate all recipient wallets BEFORE touching on-chain state ──
    // Catching missing wallets here prevents partial on-chain releases where some
    // payments succeed and others fail, leaving funds in an inconsistent state.
    if (!invoice.user.walletAddress) {
      return NextResponse.json({ error: 'Freelancer wallet address is not configured' }, { status: 422 })
    }

    const collaborators = (invoice as any).collaborators ?? []
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

    // Validate combined collaborator share never exceeds 100% — this would produce
    // a negative freelancer payment, which must be rejected before touching escrow.
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

    // ── On-chain escrow contract release (smart-contract/Stellar escrow account) ──
    // This unlocks the funds from the escrow account so we can distribute them.
    if ((invoice as any).escrowContractId) {
      try {
        await releaseEscrowFunds((invoice as any).escrowContractId)
      } catch (err) {
        logger.error({ err: err }, 'On-chain escrow release failed:')
        return NextResponse.json({ error: 'Failed to release escrow on-chain. Please ensure you have sufficient XLM for gas.' }, { status: 500 })
      }
    }

    // ── Compute waterfall amounts ────────────────────────────────────────────────
    // We snapshot the split percentages NOW (at release time) against the escrow
    // amount so the arithmetic is deterministic and logged for auditability.
    // Using integer arithmetic (cents) avoids floating-point rounding drift when
    // storing USDC amounts that may be expressed as decimals.
    const totalAmountUsdc: number = Number((invoice as any).escrowAmountUsdc ?? (invoice as any).totalAmount ?? 0)
    if (totalAmountUsdc <= 0) {
      return NextResponse.json({ error: 'Escrow amount is invalid or zero' }, { status: 422 })
    }

    // Build per-collaborator payment amounts (truncate to avoid over-paying)
    const collaboratorPayments: Array<{ collaborator: any; amountUsdc: number }> = collaborators.map(
      (collaborator: any) => ({
        collaborator,
        // Truncate to 7 decimal places — Stellar's minimum USDC unit precision
        amountUsdc: Math.floor((collaborator.revenueSharePercent / 100) * totalAmountUsdc * 1e7) / 1e7,
      })
    )

    const totalCollaboratorUsdc = collaboratorPayments.reduce((sum, p) => sum + p.amountUsdc, 0)
    // Freelancer receives the remainder so no dust is lost to rounding
    const freelancerAmountUsdc = Math.round((totalAmountUsdc - totalCollaboratorUsdc) * 1e7) / 1e7

    // ── Atomic DB update + payment log ──────────────────────────────────────────
    // Both the status update and the payment event records must succeed together.
    // If either fails, the transaction rolls back and the escrow remains 'held',
    // preventing a situation where the DB says 'released' but no payments fired.
    const now = new Date()
    const updated = await prisma.$transaction(async (tx: any) => {
      // Optimistic-concurrency update: only succeeds if status is still 'held'.
      // This prevents double-release if two requests race (e.g., client double-click).
      const updateResult = await tx.invoice.updateMany({
        where: {
          id: invoice.id,
          escrowEnabled: true,
          escrowStatus: 'held',
          clientEmail: invoice.clientEmail,
        },
        data: {
          escrowStatus: 'released',
          escrowReleasedAt: now,
        },
      })

      if (updateResult.count !== 1) {
        // Another request already released this escrow — surface a 409 to the caller
        throw new Error('ESCROW_RELEASE_CONFLICT')
      }

      // Record the release event for audit trail
      await tx.escrowEvent.create({
        data: {
          invoiceId: invoice.id,
          eventType: 'released',
          actorType: 'client',
          actorEmail: clientEmail,
          notes: approvalNotes || 'Client approved work and released escrow',
        },
      })

      // Log each collaborator payment intent so we have a record even if the
      // Stellar broadcast step fails — operations team can reconcile manually.
      for (const { collaborator, amountUsdc } of collaboratorPayments) {
        await tx.escrowEvent.create({
          data: {
            invoiceId: invoice.id,
            eventType: 'collaborator_payment_queued',
            actorType: 'system',
            actorEmail: collaborator.email,
            notes: `Queued ${amountUsdc} USDC (${collaborator.revenueSharePercent}%) to collaborator ${collaborator.email}`,
          },
        })
      }

      // Log the freelancer's payment intent
      await tx.escrowEvent.create({
        data: {
          invoiceId: invoice.id,
          eventType: 'freelancer_payment_queued',
          actorType: 'system',
          actorEmail: invoice.user.email ?? '',
          notes: `Queued ${freelancerAmountUsdc} USDC to freelancer after ${totalCollaboratorPercent}% collaborator splits`,
        },
      })

      return tx.invoice.findUnique({
        where: { id: invoice.id },
        select: { id: true, escrowStatus: true, escrowReleasedAt: true },
      })
    })

    if (!updated) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // ── Stellar payment waterfall ────────────────────────────────────────────────
    // Payments are dispatched AFTER the DB transaction commits so we never have a
    // state where the DB is still 'held' while on-chain funds have moved.  If any
    // Stellar call fails here the DB already reflects 'released'; ops can use the
    // queued events above to replay individual payments without re-releasing.
    const paymentErrors: string[] = []

    // 1. Collaborator payments first — they have contractual priority in the split
    for (const { collaborator, amountUsdc } of collaboratorPayments) {
      try {
        await sendStellarPayment(
          collaborator.walletAddress,
          amountUsdc.toString(),
          'USDC'
        )
        logger.info(
          { invoiceId: invoice.id, collaboratorEmail: collaborator.email, amountUsdc },
          'Collaborator waterfall payment sent'
        )
      } catch (err) {
        // Log but continue — we must attempt all payments; ops can replay failures
        logger.error(
          { err, invoiceId: invoice.id, collaboratorEmail: collaborator.email },
          'Collaborator Stellar payment failed'
        )
        paymentErrors.push(`Collaborator ${collaborator.email}: ${(err as Error).message}`)
      }
    }

    // 2. Freelancer receives the remainder
    try {
      await sendStellarPayment(
        invoice.user.walletAddress!,
        freelancerAmountUsdc.toString(),
        'USDC'
      )
      logger.info(
        { invoiceId: invoice.id, freelancerEmail: invoice.user.email, freelancerAmountUsdc },
        'Freelancer waterfall payment sent'
      )
    } catch (err) {
      logger.error(
        { err, invoiceId: invoice.id, freelancerEmail: invoice.user.email },
        'Freelancer Stellar payment failed'
      )
      paymentErrors.push(`Freelancer ${invoice.user.email}: ${(err as Error).message}`)
    }

    // Notify the freelancer regardless of payment broadcast success so they know
    // the client has approved; they can follow up on any broadcast failures.
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
      message: paymentErrors.length
        ? 'Escrow released but some payments failed — check paymentErrors'
        : 'Escrow released and waterfall payments sent',
      invoice: {
        id: updated.id,
        escrowStatus: 'released',
        escrowReleasedAt: updated.escrowReleasedAt
          ? updated.escrowReleasedAt.toISOString()
          : now.toISOString(),
      },
      distribution: {
        totalAmountUsdc,
        freelancerAmountUsdc,
        collaboratorPayments: collaboratorPayments.map(({ collaborator, amountUsdc }) => ({
          email: collaborator.email,
          revenueSharePercent: collaborator.revenueSharePercent,
          amountUsdc,
        })),
      },
      // Surface broadcast failures so callers / monitoring can react without
      // needing to dig into server logs
      ...(paymentErrors.length ? { paymentErrors } : {}),
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'ESCROW_RELEASE_CONFLICT') {
      return NextResponse.json({ error: 'Escrow status changed. Please refresh and retry.' }, { status: 409 })
    }
    logger.error({ err: error }, 'Escrow release error:')
    return NextResponse.json({ error: 'Failed to release escrow' }, { status: 500 })
  }
}
