import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

/**
 * GET /api/routes-d/privacy/encrypted-invoice/[id]
 * 
 * Retrieve encrypted payload for client-side decryption.
 * This is a PUBLIC endpoint (no auth required) - anyone with the link can access.
 * The decryption key is passed via URL hash fragment and never reaches the server.
 */
export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params

        const invoice = await prisma.invoice.findFirst({
            where: {
                OR: [
                    { id },
                    { invoiceNumber: id },
                ],
                isConfidential: true,
            },
            include: {
                user: {
                    select: {
                        name: true,
                        wallet: { select: { address: true } },
                    },
                },
            },
        })

        if (!invoice) {
            return NextResponse.json(
                { error: 'Invoice not found' },
                { status: 404 }
            )
        }

        // Return encrypted payload and salt for client-side decryption
        // NOTE: We intentionally do NOT log or expose any decryptable content
        return NextResponse.json({
            invoiceNumber: invoice.invoiceNumber,
            amount: Number(invoice.amount),
            currency: invoice.currency,
            status: invoice.status,
            dueDate: invoice.dueDate,
            paidAt: invoice.paidAt,
            // Encrypted fields - client will decrypt
            encryptedPayload: invoice.encryptedPayload,
            decryptionSalt: invoice.decryptionSalt,
            // Payment info (non-sensitive)
            freelancerName: invoice.user.name || 'Freelancer',
            walletAddress: invoice.user.wallet?.address || null,
        })
    } catch (error) {
        logger.error({ err: error }, 'Encrypted invoice GET [id] error:')
        return NextResponse.json(
            { error: 'Failed to fetch invoice' },
            { status: 500 }
        )
    }
}
