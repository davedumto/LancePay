import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createEncryptedInvoiceSchema } from '@/lib/encrypted-invoice-validation'
import { generateInvoiceNumber } from '@/lib/utils'
import { logger } from '@/lib/logger'

/**
 * POST /api/routes-d/privacy/encrypted-invoice
 * 
 * Create a confidential invoice with Zero-Knowledge encrypted payload.
 * The encryption happens client-side; server only stores the encrypted blob.
 */
export async function POST(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        if (!authToken) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const claims = await verifyAuthToken(authToken)
        if (!claims) {
            return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
        }

        const user = await prisma.user.findUnique({
            where: { privyId: claims.userId },
        })

        if (!user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        const body = await request.json()
        const parsed = createEncryptedInvoiceSchema.safeParse(body)

        if (!parsed.success) {
            return NextResponse.json(
                { error: parsed.error.issues[0].message },
                { status: 400 }
            )
        }

        const { amount, encryptedData, salt, clientEmail, dueDate } = parsed.data

        const invoiceNumber = generateInvoiceNumber()
        // Payment link - client will append #<key> fragment
        const paymentLink = `${process.env.NEXT_PUBLIC_APP_URL}/pay/confidential/${invoiceNumber}`

        const invoice = await prisma.invoice.create({
            data: {
                userId: user.id,
                invoiceNumber,
                // For confidential invoices, we store minimal metadata
                clientEmail: clientEmail || 'encrypted@confidential.local',
                clientName: null, // Encrypted in payload
                description: '[Confidential Invoice]', // Placeholder
                amount,
                dueDate: dueDate ? new Date(dueDate) : null,
                paymentLink,
                // Confidential invoice fields
                isConfidential: true,
                encryptedPayload: encryptedData,
                decryptionSalt: salt,
            },
        })

        return NextResponse.json(
            {
                id: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                paymentLink: invoice.paymentLink,
                amount: Number(invoice.amount),
                status: invoice.status,
                createdAt: invoice.createdAt,
                // Note: Client must append #<key> to paymentLink before sharing
            },
            { status: 201 }
        )
    } catch (error) {
        logger.error({ err: error }, 'Encrypted invoice POST error:')
        return NextResponse.json(
            { error: 'Failed to create confidential invoice' },
            { status: 500 }
        )
    }
}

/**
 * GET /api/routes-d/privacy/encrypted-invoice
 * 
 * List all confidential invoices for the authenticated user.
 */
export async function GET(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        if (!authToken) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const claims = await verifyAuthToken(authToken)
        if (!claims) {
            return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
        }

        const user = await prisma.user.findUnique({
            where: { privyId: claims.userId },
        })

        if (!user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        const invoices = await prisma.invoice.findMany({
            where: {
                userId: user.id,
                isConfidential: true,
            },
            select: {
                id: true,
                invoiceNumber: true,
                amount: true,
                status: true,
                paymentLink: true,
                dueDate: true,
                createdAt: true,
                paidAt: true,
                // Do NOT return encryptedPayload or decryptionSalt in list view
            },
            orderBy: { createdAt: 'desc' },
        })

        return NextResponse.json({
            invoices: invoices.map((inv) => ({
                ...inv,
                amount: Number(inv.amount),
            })),
        })
    } catch (error) {
        logger.error({ err: error }, 'Encrypted invoice GET error:')
        return NextResponse.json(
            { error: 'Failed to fetch confidential invoices' },
            { status: 500 }
        )
    }
}
