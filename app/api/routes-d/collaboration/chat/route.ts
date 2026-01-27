import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { sendMessageSchema } from '@/lib/chat-validation'
import { dispatchWebhooks } from '@/lib/webhooks'
import { sendInvoiceMessageEmail } from '@/lib/email'

/**
 * GET /api/routes-d/collaboration/chat?invoiceId={id}
 * 
 * Retrieve all messages for an invoice.
 * Access: Freelancer (authenticated) OR Client (via invoice link)
 */
export async function GET(request: NextRequest) {
    try {
        const invoiceId = request.nextUrl.searchParams.get('invoiceId')
        if (!invoiceId) {
            return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
        }

        // Find the invoice
        const invoice = await prisma.invoice.findFirst({
            where: {
                OR: [{ id: invoiceId }, { invoiceNumber: invoiceId }],
            },
            select: {
                id: true,
                userId: true,
                invoiceNumber: true,
            },
        })

        if (!invoice) {
            return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
        }

        // Check if user is authenticated (freelancer)
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        let isFreelancer = false

        if (authToken) {
            const claims = await verifyAuthToken(authToken)
            if (claims) {
                const user = await prisma.user.findUnique({
                    where: { privyId: claims.userId },
                    select: { id: true },
                })
                isFreelancer = user?.id === invoice.userId
            }
        }

        // Fetch messages - filter internal if client
        const messages = await prisma.invoiceMessage.findMany({
            where: {
                invoiceId: invoice.id,
                ...(isFreelancer ? {} : { isInternal: false }),
            },
            orderBy: { createdAt: 'asc' },
            select: {
                id: true,
                senderType: true,
                senderName: true,
                content: true,
                attachmentUrl: true,
                isInternal: true,
                createdAt: true,
            },
        })

        return NextResponse.json({ messages, invoiceNumber: invoice.invoiceNumber })
    } catch (error) {
        console.error('Chat GET error:', error)
        return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
    }
}

/**
 * POST /api/routes-d/collaboration/chat
 * 
 * Send a new message on an invoice thread.
 * Messages are immutable - no edit/delete allowed.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const parsed = sendMessageSchema.safeParse(body)

        if (!parsed.success) {
            return NextResponse.json(
                { error: parsed.error.issues[0].message },
                { status: 400 }
            )
        }

        const { invoiceId, content, attachmentUrl, senderName, isInternal } = parsed.data

        // Find the invoice
        const invoice = await prisma.invoice.findFirst({
            where: {
                OR: [{ id: invoiceId }, { invoiceNumber: invoiceId }],
            },
            include: {
                user: { select: { id: true, email: true, name: true } },
            },
        })

        if (!invoice) {
            return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
        }

        // Determine sender type and identity
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        let senderId: string | null = null
        let senderType: 'freelancer' | 'client' = 'client'
        let finalSenderName = senderName || 'Client'

        if (authToken) {
            const claims = await verifyAuthToken(authToken)
            if (claims) {
                const user = await prisma.user.findUnique({
                    where: { privyId: claims.userId },
                    select: { id: true, name: true },
                })
                if (user && user.id === invoice.userId) {
                    senderId = user.id
                    senderType = 'freelancer'
                    finalSenderName = user.name || 'Freelancer'
                }
            }
        }

        // Only freelancers can send internal messages
        const finalIsInternal = senderType === 'freelancer' ? (isInternal || false) : false

        // Create the message
        const message = await prisma.invoiceMessage.create({
            data: {
                invoiceId: invoice.id,
                senderId,
                senderType,
                senderName: finalSenderName,
                content,
                attachmentUrl,
                isInternal: finalIsInternal,
            },
        })

        // Send notification to the other party (unless internal)
        if (!finalIsInternal) {
            if (senderType === 'freelancer') {
                // Notify client
                await sendInvoiceMessageEmail({
                    to: invoice.clientEmail,
                    name: invoice.clientName || undefined,
                    invoiceNumber: invoice.invoiceNumber,
                    message: content,
                    senderName: finalSenderName,
                }).catch((err) => console.error('Failed to send message email to client:', err))
            } else {
                // Notify freelancer
                await sendInvoiceMessageEmail({
                    to: invoice.user.email,
                    name: invoice.user.name || undefined,
                    invoiceNumber: invoice.invoiceNumber,
                    message: content,
                    senderName: finalSenderName,
                }).catch((err) => console.error('Failed to send message email to freelancer:', err))
            }

            // Dispatch webhook
            dispatchWebhooks(invoice.userId, 'invoice.message' as any, {
                invoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                messageId: message.id,
                senderType,
                senderName: finalSenderName,
                content,
                hasAttachment: !!attachmentUrl,
                createdAt: message.createdAt.toISOString(),
            }).catch((err) => console.error('Failed to dispatch message webhook:', err))
        }

        return NextResponse.json(
            {
                id: message.id,
                senderType: message.senderType,
                senderName: message.senderName,
                content: message.content,
                attachmentUrl: message.attachmentUrl,
                isInternal: message.isInternal,
                createdAt: message.createdAt,
            },
            { status: 201 }
        )
    } catch (error) {
        console.error('Chat POST error:', error)
        return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
    }
}

/**
 * PATCH and DELETE are explicitly rejected - messages are immutable for audit trail
 */
export async function PATCH() {
    return NextResponse.json(
        { error: 'Messages cannot be edited - they serve as dispute evidence' },
        { status: 405 }
    )
}

export async function DELETE() {
    return NextResponse.json(
        { error: 'Messages cannot be deleted - they serve as dispute evidence' },
        { status: 405 }
    )
}
