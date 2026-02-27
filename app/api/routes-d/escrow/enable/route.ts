import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { deployAndInitEscrow, EscrowEnableSchema, getAuthContext } from '@/app/api/routes-d/escrow/_shared'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = EscrowEnableSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })

    const { invoiceId, releaseConditions, clientAddress } = parsed.data

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { user: { include: { wallet: true } } }
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    // Only freelancer (invoice owner) can enable escrow.
    if (invoice.userId !== auth.user.id) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })

    // Must be unpaid.
    if (invoice.status !== 'pending') return NextResponse.json({ error: 'Escrow can only be enabled on unpaid invoices' }, { status: 400 })

    // Freelancer must have a wallet to receive funds.
    if (!invoice.user.wallet?.address) {
      return NextResponse.json({ error: 'Freelancer must have a Stellar wallet configured to use Escrow' }, { status: 400 })
    }

    // Deploy and Init Contract
    // If clientAddress is not provided, we use the arbiter as a placeholder or throw
    // For this implementation, we require clientAddress if it's not in our system
    // (In a fuller implementation, we'd search for the client user by email)
    const effectiveClientAddress = clientAddress || 'GBXC37UXVECFS7BFXA7GAK52YMGMD64BY5PHMBPM6LT5EFB32IJ2HURS' // Fallback to arbiter for demo

    let contractId: string
    try {
      contractId = await deployAndInitEscrow({
        clientAddress: effectiveClientAddress,
        freelancerAddress: invoice.user.wallet.address,
        invoiceId: invoice.id,
      })
    } catch (deployError) {
      logger.error({ err: deployError }, 'Contract deployment failed:')
      return NextResponse.json({ error: 'Failed to deploy escrow contract on-chain' }, { status: 500 })
    }

    const updated = await prisma.$transaction(async (tx: any) => {
      const inv = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          escrowEnabled: true,
          escrowStatus: 'none',
          escrowContractId: contractId,
          escrowReleaseConditions: releaseConditions ?? null,
        },
        select: { id: true, escrowEnabled: true, escrowStatus: true, escrowReleaseConditions: true, escrowContractId: true },
      })

      await tx.escrowEvent.create({
        data: {
          invoiceId: invoice.id,
          eventType: 'created',
          actorType: 'freelancer',
          actorEmail: auth.email,
          notes: 'Escrow enabled on-chain',
          metadata: {
            releaseConditions: releaseConditions ?? null,
            contractId: contractId
          } as any,
        },
      })

      return inv
    })

    return NextResponse.json({
      success: true,
      invoice: {
        id: updated.id,
        escrowEnabled: updated.escrowEnabled,
        escrowStatus: updated.escrowStatus,
        escrowContractId: updated.escrowContractId,
        releaseConditions: updated.escrowReleaseConditions || '',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Escrow enable error:')
    return NextResponse.json({ error: 'Failed to enable escrow' }, { status: 500 })
  }
}

